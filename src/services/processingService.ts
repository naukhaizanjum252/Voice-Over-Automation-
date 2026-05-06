import { supabase } from '@/lib/supabase';
import type { Channel, ProcessingResult, TrelloCard } from '@/types';
import * as trelloService from './trelloService';
import { extractText } from './fileParserService';
import { generateAudio } from './voiceService';

const CONCURRENCY_LIMIT = 5;

/**
 * Runs async tasks with a concurrency limit.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Processes all active channels. Called by cron or manual trigger.
 * Channels are processed in parallel (up to CONCURRENCY_LIMIT).
 */
export async function processAllChannels(): Promise<ProcessingResult[]> {
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

  const tasks = channels.map((channel) => () => processChannel(channel as Channel));
  const channelResults = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);
  return channelResults.flat();
}

/**
 * Processes a single channel: fetches cards, extracts scripts, generates audio.
 * Cards within a channel are processed in parallel (up to CONCURRENCY_LIMIT).
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

  // Process cards in parallel with concurrency limit
  const tasks = allCards.map((card) => async () => {
    try {
      return await processCard(card, channel);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[processing] Card ${card.id} error:`, errMsg);
      return { cardId: card.id, cardName: card.name, success: false, error: errMsg } as ProcessingResult;
    }
  });

  return runWithConcurrency(tasks, CONCURRENCY_LIMIT);
}

/**
 * Processes a single Trello card.
 */
async function processCard(
  card: TrelloCard,
  channel: Channel
): Promise<ProcessingResult> {
  // Check if already processed
  const { data: existing } = await supabase
    .from('processed_cards')
    .select('id, status')
    .eq('trello_card_id', card.id)
    .single();

  if (existing && (existing.status === 'completed' || existing.status === 'processing' || existing.status === 'failed')) {
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Skip cards that already have audio attached — mark as completed
  if (trelloService.hasAudioAttachment(card.attachments || [])) {
    await upsertCard(card.id, card.name, channel.id, 'completed', 'Skipped — voiceover already attached', null, null);
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Find script attachment
  const attachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!attachment) {
    return { cardId: card.id, cardName: card.name, success: true }; // skip silently
  }

  // Upsert as processing — stage: downloading
  await upsertCard(card.id, card.name, channel.id, 'processing', null, null, 'downloading');

  try {
    // 1. Download attachment
    console.log(`[processing] Downloading attachment: ${attachment.name}`);
    const fileBuffer = await trelloService.downloadAttachment(attachment.url);

    // Stage: extracting
    await updateStage(card.id, 'extracting');
    const text = await extractText(fileBuffer, attachment.name);

    if (!text || text.trim().length === 0) {
      throw new Error('Extracted text is empty');
    }

    // Stage: queued (will move to 'generating' once 69 Labs starts processing)
    await updateStage(card.id, 'queued');
    console.log(`[processing] Generating audio for ${text.length} chars`);
    const finalAudio = await generateAudio(text, channel.voice_config, async (stage) => {
      await updateStage(card.id, stage === 'generating' ? 'generating' : 'queued');
    });
    console.log(`[processing] Audio ready: ${(finalAudio.length / 1024 / 1024).toFixed(2)} MB`);

    // Stage: uploading
    await updateStage(card.id, 'uploading');
    const sanitizedName = card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_voiceover.mp3`;
    const uploaded = await trelloService.uploadAttachmentToCard(
      card.id,
      fileName,
      finalAudio
    );

    // Done
    await upsertCard(card.id, card.name, channel.id, 'completed', null, uploaded.url, null);

    return { cardId: card.id, cardName: card.name, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await upsertCard(card.id, card.name, channel.id, 'failed', errMsg, null, null);
    return { cardId: card.id, cardName: card.name, success: false, error: errMsg };
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

  // Reset status to pending so processCard doesn't skip it
  await supabase
    .from('processed_cards')
    .update({ status: 'pending', processing_stage: null, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', processedCardId);

  // Fetch fresh card data directly by ID
  const card = await trelloService.getCardById(trelloCardId);
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

  // Reset status so processCard doesn't skip it
  await supabase
    .from('processed_cards')
    .update({ status: 'pending', processing_stage: null, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', processedCardId);

  // Fetch fresh card data directly by ID
  const card = await trelloService.getCardById(trelloCardId);
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

  // Mark as processing
  await upsertCard(trelloCardId, card.name, channel.id, 'processing', null, null, 'downloading');

  try {
    // 1. Download script
    console.log(`[manual-voiceover] Downloading attachment: ${attachment.name}`);
    const fileBuffer = await trelloService.downloadAttachment(attachment.url);

    // 2. Extract text
    await updateStage(trelloCardId, 'extracting');
    const text = await extractText(fileBuffer, attachment.name);

    if (!text || text.trim().length === 0) {
      throw new Error('Extracted text is empty');
    }

    // 3. Generate audio (skip script generation — go straight to TTS)
    await updateStage(trelloCardId, 'queued');
    console.log(`[manual-voiceover] Generating audio for ${text.length} chars`);
    const finalAudio = await generateAudio(text, channel.voice_config, async (stage) => {
      await updateStage(trelloCardId, stage === 'generating' ? 'generating' : 'queued');
    });
    console.log(`[manual-voiceover] Audio ready: ${(finalAudio.length / 1024 / 1024).toFixed(2)} MB`);

    // 4. Upload to Trello
    await updateStage(trelloCardId, 'uploading');
    const sanitizedName = card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_voiceover.mp3`;
    const uploaded = await trelloService.uploadAttachmentToCard(card.id, fileName, finalAudio);

    // Done
    await upsertCard(trelloCardId, card.name, channel.id, 'completed', null, uploaded.url, null);
    return { cardId: card.id, cardName: card.name, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await upsertCard(trelloCardId, card.name, channel.id, 'failed', errMsg, null, null);
    return { cardId: card.id, cardName: card.name, success: false, error: errMsg };
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
