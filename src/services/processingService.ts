import { supabase } from '@/lib/supabase';
import type { Channel, ProcessingResult, TrelloCard } from '@/types';
import * as trelloService from './trelloService';
import { extractText } from './fileParserService';
import { generateAudio } from './voiceService';
import { fetchPrimaryDocTexts, processChannelScripts } from './scriptProcessingService';

const STALE_PROCESSING_MINUTES = 15; // Cards stuck in "processing" longer than this are auto-reset
const CONCURRENCY_LIMIT = 8;

/**
 * Runs tasks concurrently with a worker pool (up to `limit` workers).
 */
async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ── Cancellation registry ──
// Maps trello_card_id → AbortController for in-progress cards.
// When a card is terminated, its controller is aborted, which cancels
// all downstream fetch calls and polling loops.
const activeControllers = new Map<string, AbortController>();

/**
 * Cancels a running card process.
 * Called by the terminate API endpoint.
 * Returns true if the card was actively being processed.
 */
export function cancelCardProcess(trelloCardId: string): boolean {
  const controller = activeControllers.get(trelloCardId);
  if (controller) {
    console.log(`[processing] Cancelling active process for card ${trelloCardId}`);
    controller.abort();
    activeControllers.delete(trelloCardId);
    return true;
  }
  return false;
}

/**
 * Recovers cards stuck in "processing" state.
 * If a card has been processing for longer than STALE_PROCESSING_MINUTES,
 * it means the process that was handling it crashed/timed out.
 *
 * Uses retry_count to prevent infinite loops:
 * - retry_count < MAX_AUTO_RETRIES → reset to "pending" for auto-retry
 * - retry_count >= MAX_AUTO_RETRIES → mark as "failed" permanently
 */
const MAX_AUTO_RETRIES = 2;

export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString();

  const { data: staleCards, error: fetchError } = await supabase
    .from('processed_cards')
    .select('id, trello_card_id, card_name, updated_at, retry_count')
    .eq('status', 'processing')
    .lt('updated_at', cutoff);

  if (fetchError) {
    console.error('[stale-recovery] Failed to query stale jobs:', fetchError.message);
    return 0;
  }

  if (!staleCards || staleCards.length === 0) return 0;

  console.log(`[stale-recovery] Found ${staleCards.length} stale processing jobs (>${STALE_PROCESSING_MINUTES}min old)`);

  for (const card of staleCards) {
    const staleMins = Math.round((Date.now() - new Date(card.updated_at).getTime()) / 60000);
    const retryCount = (card.retry_count || 0) + 1;

    if (retryCount > MAX_AUTO_RETRIES) {
      // Too many retries — mark as permanently failed
      console.log(`[stale-recovery] Card "${card.card_name}" failed after ${retryCount - 1} retries (stuck for ${staleMins}min) → failed`);
      const { error: updateError } = await supabase
        .from('processed_cards')
        .update({
          status: 'failed',
          processing_stage: null,
          error_message: `Voiceover generation timed out after ${retryCount - 1} attempts`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', card.id);

      if (updateError) {
        console.error(`[stale-recovery] Failed to update card ${card.id}:`, updateError.message);
      }
    } else {
      // Still have retries left — reset to pending
      console.log(`[stale-recovery] Resetting card "${card.card_name}" (stuck for ${staleMins}min, retry ${retryCount}/${MAX_AUTO_RETRIES}) → pending`);
      const { error: updateError } = await supabase
        .from('processed_cards')
        .update({
          status: 'pending',
          processing_stage: null,
          error_message: null,
          retry_count: retryCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', card.id);

      if (updateError) {
        console.error(`[stale-recovery] Failed to reset card ${card.id}:`, updateError.message);
      }
    }
  }

  return staleCards.length;
}

/**
 * Processes all active channels. Called by cron or manual trigger.
 */
export async function processAllChannels(): Promise<ProcessingResult[]> {
  // Step 0: Recover any cards stuck in "processing" from crashed runs
  const recovered = await recoverStaleJobs();
  if (recovered > 0) {
    console.log(`[cron] Recovered ${recovered} stale jobs before processing.`);
  }

  console.log('[cron] Fetching auto-run channels...');
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('auto_run_enabled', true);

  console.log('[cron] Channels query:', { count: channels?.length ?? 0, error: error?.message ?? null });

  if (error) throw new Error(`Failed to fetch channels: ${error.message}`);
  if (!channels || channels.length === 0) {
    console.log('[cron] No auto-run channels found, skipping.');
    return [];
  }

  const results: ProcessingResult[] = [];
  for (const channel of channels) {
    const channelResults = await processChannel(channel as Channel);
    results.push(...channelResults);
  }
  return results;
}

/**
 * Processes a single channel: fetches cards, extracts scripts, generates audio.
 * Cards are processed concurrently (up to CONCURRENCY_LIMIT at a time).
 */
export async function processChannel(
  channel: Channel
): Promise<ProcessingResult[]> {
  // Gather all cards from all lists
  const allCards: TrelloCard[] = [];
  for (const listId of channel.trello_list_ids) {
    try {
      const cards = await trelloService.getCardsInList(listId);
      allCards.push(...cards);
    } catch (err) {
      console.error(`[processing] Failed to fetch list ${listId}:`, err);
    }
  }

  if (allCards.length === 0) return [];

  // Process cards concurrently (up to CONCURRENCY_LIMIT at a time)
  const results = await runWithConcurrency(allCards, CONCURRENCY_LIMIT, async (card) => {
    try {
      return await processCard(card, channel);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[processing] Card ${card.id} error:`, errMsg);
      return { cardId: card.id, cardName: card.name, success: false, error: errMsg };
    }
  });
  return results;
}

/**
 * Processes a single Trello card.
 */
async function processCard(
  card: TrelloCard,
  channel: Channel
): Promise<ProcessingResult> {
  // Skip cards that already have audio attached
  if (trelloService.hasAudioAttachment(card.attachments || [])) {
    await upsertCard(card.id, card.name, channel.id, 'completed', 'Skipped — voiceover already attached', null, null);
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Find script attachment
  const attachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!attachment) {
    console.log(`[processing] Card "${card.name}" has no script attachment, skipping`);
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Atomically claim this card — only proceed if status is 'pending' or no record exists.
  const { data: existing } = await supabase
    .from('processed_cards')
    .select('id, status')
    .eq('trello_card_id', card.id)
    .single();

  if (existing) {
    if (existing.status === 'completed' || existing.status === 'processing' || existing.status === 'failed') {
      return { cardId: card.id, cardName: card.name, success: true };
    }
    // Card is 'pending' — atomically claim it with conditional update
    const { data: claimed } = await supabase
      .from('processed_cards')
      .update({
        status: 'processing',
        processing_stage: 'downloading',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('trello_card_id', card.id)
      .eq('status', 'pending')
      .select('id');

    if (!claimed || claimed.length === 0) {
      console.log(`[processing] Card "${card.name}" was claimed by another process, skipping`);
      return { cardId: card.id, cardName: card.name, success: true };
    }
  } else {
    // No record — insert to claim (unique constraint prevents duplicates)
    const { error: insertErr } = await supabase
      .from('processed_cards')
      .insert({
        trello_card_id: card.id,
        card_name: card.name,
        channel_id: channel.id,
        status: 'processing',
        processing_stage: 'downloading',
        updated_at: new Date().toISOString(),
      });

    if (insertErr) {
      if (insertErr.code === '23505') {
        console.log(`[processing] Card "${card.name}" already claimed, skipping`);
        return { cardId: card.id, cardName: card.name, success: true };
      }
      return { cardId: card.id, cardName: card.name, success: false, error: insertErr.message };
    }
  }

  // Card is now claimed (status = processing, stage = downloading).
  // Create an AbortController so it can be cancelled.
  const abortController = new AbortController();
  activeControllers.set(card.id, abortController);

  try {
    // 1. Download attachment
    console.log(`[processing] Downloading attachment: ${attachment.name}`);
    const fileBuffer = await trelloService.downloadAttachment(attachment.url);

    checkAborted(abortController.signal);

    // Stage: extracting
    await updateStage(card.id, 'extracting');
    const text = await extractText(fileBuffer, attachment.name);

    if (!text || text.trim().length === 0) {
      throw new Error('Extracted text is empty');
    }

    checkAborted(abortController.signal);

    // Stage: generating voice
    await updateStage(card.id, 'generating');
    console.log(`[processing] Generating audio for ${text.length} chars`);
    const finalAudio = await generateAudio(text, channel.voice_config, async (stage) => {
      await updateStage(card.id, stage === 'queued' ? 'queued' : 'generating');
    }, abortController.signal);
    console.log(`[processing] Audio ready: ${(finalAudio.length / 1024 / 1024).toFixed(2)} MB`);

    checkAborted(abortController.signal);

    // Stage: uploading
    await updateStage(card.id, 'uploading');
    const sanitizedName = card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_voiceover.mp3`;
    const uploaded = await trelloService.uploadAttachmentToCard(
      card.id,
      fileName,
      finalAudio
    );

    // Check abort one final time before marking completed —
    // if terminate was called during upload, don't overwrite "failed" with "completed"
    checkAborted(abortController.signal);

    // Done
    await upsertCard(card.id, card.name, channel.id, 'completed', null, uploaded.url, null);

    return { cardId: card.id, cardName: card.name, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAborted = abortController.signal.aborted;
    // Don't overwrite the "failed/Terminated" status if it was a cancellation
    if (!isAborted) {
      await upsertCard(card.id, card.name, channel.id, 'failed', errMsg, null, null);
    }
    return { cardId: card.id, cardName: card.name, success: false, error: isAborted ? 'Terminated by user' : errMsg };
  } finally {
    activeControllers.delete(card.id);
  }
}

/** Throws if the signal has been aborted. */
function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Terminated by user');
  }
}

/**
 * Retries a single failed card by its processed_cards ID.
 */
export async function retryCard(processedCardId: string): Promise<ProcessingResult> {
  const { data: record, error } = await supabase
    .from('processed_cards')
    .select('*, channels(*)')
    .eq('id', processedCardId)
    .single();

  if (error || !record) throw new Error('Card record not found');

  const channel = record.channels as Channel;
  const trelloCardId = record.trello_card_id;

  // Fetch fresh card data directly by ID
  const card = await trelloService.getCardById(trelloCardId);

  // Check if card has a script attachment — if not, it needs Phase 1 (script generation)
  const scriptAttachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!scriptAttachment && channel.title_list_mappings?.length > 0) {
    // Delete the DB record so Phase 1 picks it up fresh
    console.log(`[retry] Card "${card.name}" has no script — deleting record for Phase 1 re-processing`);
    await supabase.from('processed_cards').delete().eq('id', processedCardId);
    // Run Phase 1 immediately for this channel
    const primaryDocTexts = await fetchPrimaryDocTexts();
    const results = await processChannelScripts(channel, primaryDocTexts);
    const thisResult = results.find((r) => r.cardId === trelloCardId);
    return thisResult ?? { cardId: trelloCardId, cardName: card.name, success: true };
  }

  // Has a script — reset and run Phase 2 (voiceover)
  await supabase
    .from('processed_cards')
    .update({ status: 'pending', processing_stage: null, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', processedCardId);

  return processCard(card, channel);
}

/**
 * Manual trigger: re-runs the FULL pipeline for a card (download → extract → TTS → upload).
 * Ignores current status — always reprocesses from scratch.
 */
export async function manualRunFull(processedCardId: string): Promise<ProcessingResult> {
  const { data: record, error } = await supabase
    .from('processed_cards')
    .select('*, channels(*)')
    .eq('id', processedCardId)
    .single();

  if (error || !record) throw new Error('Card record not found');

  const channel = record.channels as Channel;
  const trelloCardId = record.trello_card_id;

  // Fetch fresh card data directly by ID
  const card = await trelloService.getCardById(trelloCardId);

  // Check if card has a script attachment — if not, it needs Phase 1 (script generation)
  const scriptAttachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!scriptAttachment && channel.title_list_mappings?.length > 0) {
    // Delete the DB record so Phase 1 picks it up fresh
    console.log(`[manual-full] Card "${card.name}" has no script — deleting record for Phase 1 re-processing`);
    await supabase.from('processed_cards').delete().eq('id', processedCardId);
    // Run Phase 1 immediately for this channel
    const primaryDocTexts = await fetchPrimaryDocTexts();
    const results = await processChannelScripts(channel, primaryDocTexts);
    const thisResult = results.find((r) => r.cardId === trelloCardId);
    return thisResult ?? { cardId: trelloCardId, cardName: card.name, success: true };
  }

  // Has a script — reset and run Phase 2 (voiceover)
  await supabase
    .from('processed_cards')
    .update({ status: 'pending', processing_stage: null, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', processedCardId);

  return processCard(card, channel);
}

/**
 * Manual trigger: re-runs ONLY the voiceover generation (TTS → upload).
 * Reuses the existing script attachment — skips download & extract if text can be reused.
 */
export async function manualRunVoiceover(processedCardId: string): Promise<ProcessingResult> {
  const { data: record, error } = await supabase
    .from('processed_cards')
    .select('*, channels(*)')
    .eq('id', processedCardId)
    .single();

  if (error || !record) throw new Error('Card record not found');

  const channel = record.channels as Channel;
  const trelloCardId = record.trello_card_id;

  // Fetch fresh card data
  const card = await trelloService.getCardById(trelloCardId);

  // Find script attachment
  const attachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!attachment) {
    throw new Error('No script attachment found on this card');
  }

  // Create an AbortController for this card so it can be cancelled
  const abortController = new AbortController();
  activeControllers.set(trelloCardId, abortController);

  // Mark as processing
  await upsertCard(trelloCardId, card.name, channel.id, 'processing', null, null, 'downloading');

  try {
    // 1. Download script
    console.log(`[manual-voiceover] Downloading attachment: ${attachment.name}`);
    const fileBuffer = await trelloService.downloadAttachment(attachment.url);

    checkAborted(abortController.signal);

    // 2. Extract text
    await updateStage(trelloCardId, 'extracting');
    const text = await extractText(fileBuffer, attachment.name);

    if (!text || text.trim().length === 0) {
      throw new Error('Extracted text is empty');
    }

    checkAborted(abortController.signal);

    // 3. Generate audio (skip script generation — go straight to TTS)
    await updateStage(trelloCardId, 'generating');
    console.log(`[manual-voiceover] Generating audio for ${text.length} chars`);
    const finalAudio = await generateAudio(text, channel.voice_config, async (stage) => {
      await updateStage(trelloCardId, stage === 'generating' ? 'generating' : 'generating');
    }, abortController.signal);
    console.log(`[manual-voiceover] Audio ready: ${(finalAudio.length / 1024 / 1024).toFixed(2)} MB`);

    checkAborted(abortController.signal);

    // 4. Upload to Trello
    await updateStage(trelloCardId, 'uploading');
    const sanitizedName = card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_voiceover.mp3`;
    const uploaded = await trelloService.uploadAttachmentToCard(card.id, fileName, finalAudio);

    // Check abort one final time before marking completed
    checkAborted(abortController.signal);

    // Done
    await upsertCard(trelloCardId, card.name, channel.id, 'completed', null, uploaded.url, null);
    return { cardId: card.id, cardName: card.name, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAborted = abortController.signal.aborted;
    if (!isAborted) {
      await upsertCard(trelloCardId, card.name, channel.id, 'failed', errMsg, null, null);
    }
    return { cardId: card.id, cardName: card.name, success: false, error: isAborted ? 'Terminated by user' : errMsg };
  } finally {
    activeControllers.delete(trelloCardId);
  }
}

// ── Helpers ──

async function upsertCard(
  trelloCardId: string,
  cardName: string,
  channelId: string,
  status: string,
  errorMessage?: string | null,
  attachmentUrl?: string | null,
  processingStage?: string | null
) {
  // First check if a record exists to preserve script_url
  const { data: existing } = await supabase
    .from('processed_cards')
    .select('script_url')
    .eq('trello_card_id', trelloCardId)
    .single();

  const { error } = await supabase.from('processed_cards').upsert(
    {
      trello_card_id: trelloCardId,
      card_name: cardName,
      channel_id: channelId,
      status,
      processing_stage: processingStage ?? null,
      error_message: errorMessage ?? null,
      attachment_url: attachmentUrl ?? null,
      script_url: existing?.script_url ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'trello_card_id' }
  );

  if (error) {
    console.error(`[processing] Failed to upsert card ${trelloCardId}:`, error.message);
  }
}

async function updateStage(trelloCardId: string, stage: string) {
  const { error } = await supabase
    .from('processed_cards')
    .update({
      processing_stage: stage,
      updated_at: new Date().toISOString(),
    })
    .eq('trello_card_id', trelloCardId);

  if (error) {
    console.error(`[processing] Failed to update stage for ${trelloCardId}:`, error.message);
  }
}
