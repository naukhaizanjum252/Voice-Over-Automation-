import { supabase } from '@/lib/supabase';
import type { Channel, ProcessingResult, TrelloCard, TtsJob, TrelloAttachment } from '@/types';
import * as trelloService from './trelloService';
import { extractText } from './fileParserService';
import { startTtsJob, pollTtsJob } from './voiceService';
import { fetchPrimaryDocTexts, processChannelScripts } from './scriptProcessingService';

const STALE_PROCESSING_MINUTES = 15;   // Cards stuck in "processing" with NO in-flight job (died during download/extract/start)
const MAX_JOB_AGE_MINUTES = 45;        // In-flight TTS job that never completes → give up
const CONCURRENCY_LIMIT = 8;
const MAX_AUTO_RETRIES = 2;

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

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Cancellation registry ──
// The async model only blocks briefly (download/extract/start), so this mainly aborts
// the short start phase. Terminating an already-started job is done by clearing its
// tts_job in the DB (see the terminate route) so the resume step skips it.
const activeControllers = new Map<string, AbortController>();

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

/** Throws if the signal has been aborted. */
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Terminated by user');
}

// ── Stale recovery (cards that died BEFORE a job was started) ──

/**
 * Recovers cards stuck in "processing" that have NO in-flight tts_job — i.e. the run
 * crashed/timed out during download/extract/start, before a provider job existed.
 * Cards WITH a tts_job are handled by resumeInFlightJobs (+ its own age cap) instead.
 */
export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString();

  const { data: staleCards, error: fetchError } = await supabase
    .from('processed_cards')
    .select('id, trello_card_id, card_name, updated_at, retry_count')
    .eq('status', 'processing')
    .is('tts_job', null)
    .lt('updated_at', cutoff);

  if (fetchError) {
    console.error('[stale-recovery] Failed to query stale jobs:', fetchError.message);
    return 0;
  }
  if (!staleCards || staleCards.length === 0) return 0;

  console.log(`[stale-recovery] Found ${staleCards.length} stale (no-job) processing cards (>${STALE_PROCESSING_MINUTES}min)`);

  for (const card of staleCards) {
    const staleMins = Math.round((Date.now() - new Date(card.updated_at).getTime()) / 60000);
    const retryCount = (card.retry_count || 0) + 1;

    if (retryCount > MAX_AUTO_RETRIES) {
      console.log(`[stale-recovery] "${card.card_name}" failed after ${retryCount - 1} retries (stuck ${staleMins}min) → failed`);
      await supabase.from('processed_cards').update({
        status: 'failed',
        processing_stage: null,
        error_message: `Voiceover generation timed out after ${retryCount - 1} attempts`,
        updated_at: new Date().toISOString(),
      }).eq('id', card.id);
    } else {
      console.log(`[stale-recovery] Resetting "${card.card_name}" (stuck ${staleMins}min, retry ${retryCount}/${MAX_AUTO_RETRIES}) → pending`);
      await supabase.from('processed_cards').update({
        status: 'pending',
        processing_stage: null,
        error_message: null,
        retry_count: retryCount,
        updated_at: new Date().toISOString(),
      }).eq('id', card.id);
    }
  }

  return staleCards.length;
}

// ── Resume in-flight jobs (the async heart) ──

type CardWithChannel = {
  id: string;
  trello_card_id: string;
  card_name: string;
  channel_id: string;
  tts_job: TtsJob | null;
  channels: Channel;
};

/**
 * Checks every card that has a persisted tts_job exactly once:
 *  - running → heartbeat updated_at and leave it
 *  - done    → download audio, upload to Trello, mark completed, clear job
 *  - failed  → fall back to an untried provider, or mark failed
 * This is what lets a long AI84 queue span multiple cron runs without re-submitting.
 */
export async function resumeInFlightJobs(): Promise<number> {
  const { data: cards, error } = await supabase
    .from('processed_cards')
    .select('id, trello_card_id, card_name, channel_id, tts_job, channels(*)')
    .not('tts_job', 'is', null);

  if (error) {
    console.error('[resume] Failed to query in-flight jobs:', error.message);
    return 0;
  }
  if (!cards || cards.length === 0) return 0;

  console.log(`[resume] ${cards.length} in-flight TTS job(s) to check`);
  await runWithConcurrency(cards as unknown as CardWithChannel[], CONCURRENCY_LIMIT, async (rec) => {
    try {
      await resumeCard(rec);
    } catch (err) {
      console.error(`[resume] card "${rec.card_name}" error:`, err instanceof Error ? err.message : err);
    }
  });
  return cards.length;
}

async function resumeCard(rec: CardWithChannel): Promise<void> {
  const job = rec.tts_job;
  const channel = rec.channels;
  const trelloCardId = rec.trello_card_id;
  if (!job) return;

  // Age cap — abandon a job that has been in-flight too long.
  const ageMin = (Date.now() - new Date(job.startedAt).getTime()) / 60000;
  if (ageMin > MAX_JOB_AGE_MINUTES) {
    console.warn(`[resume] "${rec.card_name}" job ${job.jobId} exceeded ${MAX_JOB_AGE_MINUTES}min — failing`);
    await failCard(trelloCardId, `TTS job timed out after ${Math.round(ageMin)} minutes`);
    return;
  }

  const result = await pollTtsJob(job);

  if (result.state === 'running') {
    await touchCard(trelloCardId); // heartbeat so stale-recovery never touches an active job
    return;
  }

  if (result.state === 'done') {
    await finishDoneJob(trelloCardId, rec.card_name, result.audio);
    console.log(`[resume] "${rec.card_name}" completed via ${job.provider}`);
    return;
  }

  // failed → try an untried provider, else fail
  console.warn(`[resume] "${rec.card_name}" ${job.provider} job failed: ${result.error}`);
  await tryFallbackOrFail(rec, channel, job, result.error);
}

/** After a job fails, re-fetch the script and start an untried provider; otherwise mark failed. */
async function tryFallbackOrFail(rec: CardWithChannel, channel: Channel, job: TtsJob, error: string): Promise<void> {
  try {
    const card = await trelloService.getCardById(rec.trello_card_id);
    const attachment = trelloService.getScriptAttachment(card.attachments || []);
    if (!attachment) throw new Error('script attachment missing on card');

    const fileBuffer = await trelloService.downloadAttachment(attachment.url);
    const text = await extractText(fileBuffer, attachment.name, attachment.mimeType);
    if (!text || !text.trim()) throw new Error('extracted text is empty');

    const newJob = await startTtsJob(text, channel.voice_config, job.triedProviders);
    await setTtsJob(rec.trello_card_id, newJob);
    console.log(`[resume] "${rec.card_name}" fell back to ${newJob.provider} job ${newJob.jobId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failCard(rec.trello_card_id, `TTS failed: ${error} | fallback: ${msg}`);
  }
}

// ── Cron entrypoints ──

export async function processAllChannels(): Promise<ProcessingResult[]> {
  // 1. Recover cards that died before a job started.
  const recovered = await recoverStaleJobs();
  if (recovered > 0) console.log(`[cron] Recovered ${recovered} stale (no-job) cards.`);

  // 2. Advance/finish in-flight jobs from previous runs.
  const resumed = await resumeInFlightJobs();
  if (resumed > 0) console.log(`[cron] Checked ${resumed} in-flight job(s).`);

  // 3. Start jobs for new cards.
  console.log('[cron] Fetching auto-run channels...');
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('auto_run_enabled', true);

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
 * Starts TTS jobs for all of a channel's cards (concurrently). Does NOT wait for audio —
 * resumeInFlightJobs picks each job up on a later run.
 */
export async function processChannel(channel: Channel): Promise<ProcessingResult[]> {
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
 * Claims a card and STARTS a TTS job for it (no polling). The resume step finishes it.
 */
async function processCard(card: TrelloCard, channel: Channel): Promise<ProcessingResult> {
  // Skip cards that already have audio attached
  if (trelloService.hasAudioAttachment(card.attachments || [])) {
    await upsertCard(card.id, card.name, channel.id, 'completed', 'Skipped — voiceover already attached', null, null);
    return { cardId: card.id, cardName: card.name, success: true };
  }

  const attachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!attachment) {
    console.log(`[processing] Card "${card.name}" has no script attachment, skipping`);
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Claim atomically — only proceed if pending or no record.
  const { data: existing } = await supabase
    .from('processed_cards')
    .select('id, status, tts_job')
    .eq('trello_card_id', card.id)
    .single();

  if (existing) {
    // Already has an in-flight job → resume handles it; never re-submit (would burn credits).
    if (existing.tts_job) {
      return { cardId: card.id, cardName: card.name, success: true };
    }
    if (existing.status === 'completed' || existing.status === 'processing' || existing.status === 'failed') {
      return { cardId: card.id, cardName: card.name, success: true };
    }
    const { data: claimed } = await supabase
      .from('processed_cards')
      .update({ status: 'processing', processing_stage: 'downloading', error_message: null, updated_at: new Date().toISOString() })
      .eq('trello_card_id', card.id)
      .eq('status', 'pending')
      .select('id');

    if (!claimed || claimed.length === 0) {
      console.log(`[processing] Card "${card.name}" was claimed by another process, skipping`);
      return { cardId: card.id, cardName: card.name, success: true };
    }
  } else {
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

  // Claimed → download, extract, start a job, persist it, return.
  const abortController = new AbortController();
  activeControllers.set(card.id, abortController);
  try {
    return await startCardTts(card.id, card.name, channel, attachment, abortController.signal);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!abortController.signal.aborted) {
      await failCard(card.id, errMsg);
    }
    return { cardId: card.id, cardName: card.name, success: false, error: abortController.signal.aborted ? 'Terminated by user' : errMsg };
  } finally {
    activeControllers.delete(card.id);
  }
}

/**
 * Downloads the script, extracts text, starts a TTS job, and persists it on the card.
 * Returns as soon as the job is started — completion happens in the resume step.
 */
async function startCardTts(
  trelloCardId: string,
  cardName: string,
  channel: Channel,
  attachment: TrelloAttachment,
  signal?: AbortSignal
): Promise<ProcessingResult> {
  console.log(`[processing] Downloading attachment: ${attachment.name}`);
  const fileBuffer = await trelloService.downloadAttachment(attachment.url);
  checkAborted(signal);

  await updateStage(trelloCardId, 'extracting');
  const text = await extractText(fileBuffer, attachment.name, attachment.mimeType);
  if (!text || text.trim().length === 0) {
    throw new Error('Extracted text is empty');
  }
  checkAborted(signal);

  await updateStage(trelloCardId, 'queued');
  const job = await startTtsJob(text, channel.voice_config);
  await setTtsJob(trelloCardId, job);
  console.log(`[processing] "${cardName}" started ${job.provider} job ${job.jobId} (${text.length} chars) → resume will finish`);
  return { cardId: trelloCardId, cardName, success: true };
}

// ── Card actions (retry / manual run) ──

/**
 * Retry / manual-run share one path: resume an in-flight job if present, otherwise
 * (re)start it. `allowPhase1` lets a card with no script regenerate the script first.
 */
async function kickCard(processedCardId: string, allowPhase1: boolean): Promise<ProcessingResult> {
  const { data: record, error } = await supabase
    .from('processed_cards')
    .select('*, channels(*)')
    .eq('id', processedCardId)
    .single();

  if (error || !record) throw new Error('Card record not found');

  const channel = record.channels as Channel;
  const trelloCardId = record.trello_card_id as string;
  const cardName = record.card_name as string;

  // If a job is already in flight, resume it instead of starting a new one.
  if (record.tts_job) {
    const job = record.tts_job as TtsJob;
    const result = await pollTtsJob(job);
    if (result.state === 'done') {
      await finishDoneJob(trelloCardId, cardName, result.audio);
      return { cardId: trelloCardId, cardName, success: true };
    }
    if (result.state === 'running') {
      await touchCard(trelloCardId);
      return { cardId: trelloCardId, cardName, success: true };
    }
    // failed → clear and fall through to a fresh (re)start
    await clearTtsJob(trelloCardId);
  }

  const card = await trelloService.getCardById(trelloCardId);
  const scriptAttachment = trelloService.getScriptAttachment(card.attachments || []);

  // No script yet → regenerate the script (Phase 1) if this channel does that.
  if (!scriptAttachment && allowPhase1 && channel.title_list_mappings?.length > 0) {
    console.log(`[kick] "${card.name}" has no script — deleting record for Phase 1 re-processing`);
    await supabase.from('processed_cards').delete().eq('id', processedCardId);
    const primaryDocTexts = await fetchPrimaryDocTexts();
    const results = await processChannelScripts(channel, primaryDocTexts);
    return results.find((r) => r.cardId === trelloCardId) ?? { cardId: trelloCardId, cardName: card.name, success: true };
  }

  if (!scriptAttachment) {
    throw new Error('No script attachment found on this card');
  }

  // Reset and start a fresh TTS job (resume finishes it).
  await supabase
    .from('processed_cards')
    .update({ status: 'processing', processing_stage: 'downloading', error_message: null, tts_job: null, updated_at: new Date().toISOString() })
    .eq('id', processedCardId);

  return startCardTts(trelloCardId, card.name, channel, scriptAttachment);
}

export function retryCard(processedCardId: string): Promise<ProcessingResult> {
  return kickCard(processedCardId, true);
}

export function manualRunFull(processedCardId: string): Promise<ProcessingResult> {
  return kickCard(processedCardId, true);
}

export function manualRunVoiceover(processedCardId: string): Promise<ProcessingResult> {
  return kickCard(processedCardId, false);
}

// ── DB helpers (keyed by trello_card_id) ──

/** Uploads finished audio to Trello and marks the card completed. */
async function finishDoneJob(trelloCardId: string, cardName: string, audio: Buffer): Promise<void> {
  await updateStage(trelloCardId, 'uploading');
  const sanitizedName = cardName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  const fileName = `${sanitizedName}_voiceover.mp3`;
  const uploaded = await trelloService.uploadAttachmentToCard(trelloCardId, fileName, audio);
  await completeCard(trelloCardId, uploaded.url);
}

async function setTtsJob(trelloCardId: string, job: TtsJob): Promise<void> {
  const { error } = await supabase.from('processed_cards').update({
    status: 'processing',
    processing_stage: 'generating',
    error_message: null,
    tts_job: job,
    updated_at: new Date().toISOString(),
  }).eq('trello_card_id', trelloCardId);
  if (error) console.error(`[processing] Failed to set tts_job for ${trelloCardId}:`, error.message);
}

async function clearTtsJob(trelloCardId: string): Promise<void> {
  await supabase.from('processed_cards').update({ tts_job: null, updated_at: new Date().toISOString() }).eq('trello_card_id', trelloCardId);
}

async function completeCard(trelloCardId: string, attachmentUrl: string | null): Promise<void> {
  const { error } = await supabase.from('processed_cards').update({
    status: 'completed',
    processing_stage: null,
    error_message: null,
    attachment_url: attachmentUrl,
    tts_job: null,
    updated_at: new Date().toISOString(),
  }).eq('trello_card_id', trelloCardId);
  if (error) console.error(`[processing] Failed to complete ${trelloCardId}:`, error.message);
}

async function failCard(trelloCardId: string, message: string): Promise<void> {
  const { error } = await supabase.from('processed_cards').update({
    status: 'failed',
    processing_stage: null,
    error_message: message,
    tts_job: null,
    updated_at: new Date().toISOString(),
  }).eq('trello_card_id', trelloCardId);
  if (error) console.error(`[processing] Failed to fail ${trelloCardId}:`, error.message);
}

/** Heartbeat — refresh updated_at while a job is still running. */
async function touchCard(trelloCardId: string): Promise<void> {
  await supabase.from('processed_cards').update({
    processing_stage: 'generating',
    updated_at: new Date().toISOString(),
  }).eq('trello_card_id', trelloCardId);
}

async function updateStage(trelloCardId: string, stage: string): Promise<void> {
  const { error } = await supabase
    .from('processed_cards')
    .update({ processing_stage: stage, updated_at: new Date().toISOString() })
    .eq('trello_card_id', trelloCardId);
  if (error) console.error(`[processing] Failed to update stage for ${trelloCardId}:`, error.message);
}

/**
 * Upsert used for the audio-already-attached short-circuit. Preserves script_url.
 */
async function upsertCard(
  trelloCardId: string,
  cardName: string,
  channelId: string,
  status: string,
  errorMessage?: string | null,
  attachmentUrl?: string | null,
  processingStage?: string | null
): Promise<void> {
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
      tts_job: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'trello_card_id' }
  );

  if (error) console.error(`[processing] Failed to upsert card ${trelloCardId}:`, error.message);
}
