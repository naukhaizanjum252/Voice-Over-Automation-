import { env } from '@/lib/env';
import type { VoiceConfig, TtsPollResult } from '@/types';

/**
 * AI84.pro TTS — Fallback provider when 69 Labs fails.
 *
 * Async flow:
 *   POST /v1/minimax/text-to-speech/async → { job_id, status: "queued" }
 *   GET  /v1/minimax/text-to-speech/async/:job_id → poll until status "done" → audio_url
 *
 * Auth: xi-api-key header
 * Voice IDs use `canonical_voice_id` (different system from 69 Labs voiceId)
 *
 * Voice matching: When falling back, we fetch AI84's voice catalog and find
 * the closest match to the 69 Labs voice by: exact ID → exact name → fuzzy name + gender.
 */

const BASE = 'https://api.ai84.pro';
const POLL_INTERVAL_MS = 5000;

/**
 * Hardcoded ElevenLabs → AI84 cloned voice name mapping.
 * These are cloned voices on AI84 that correspond to specific ElevenLabs voice IDs.
 * AI84 cloned voice names typically contain the ElevenLabs voice ID.
 * This map is checked FIRST before any dynamic matching.
 */
const ELEVENLABS_TO_AI84_NAME: Record<string, string> = {
  'DOxvgnLTeU5EvNiGdfOp': 'Tartaria - DOxvgnLTeU5EvNiGdfOp',
  'sRYzP8TwEiiqAWebdYPJ': 'JAPANESE - sRYzP8TwEiiqAWebdYPJ',
  'u8GDilEiJPUbRk87Lcqs': 'SLEEPY UK - u8GDilEiJPUbRk87Lcqs',
  '4yye0QE5YPsKbMOCGGlj': 'SLEEPY AUSTRALIA - 4yye0QE5YPsKbMOCGGlj',
  'UGTtbzgh3HObxRjWaSpr': 'OMEGAVERSE -UGTtbzgh3HObxRjWaSpr',
  'VU16byTywsWv5JpI8rbc': 'OMEGAVERSE - VU16byTywsWv5JpI8rbc',
  'zGjIP4SZlMnY9m93k97r': 'CUPID CINEMA - zGjIP4SZlMnY9m93k97r',
  // NOTE: this ElevenLabs ID has TWO AI84 clones — the French one below and a Polish one
  // ("8fcyCHOzlKDlxh1InJSf - SmakPrawdy - Dish Polish"). A single ID can only map to one
  // name; keeping French. If Polish is needed, it must be selected another way.
  '8fcyCHOzlKDlxh1InJSf': '8fcyCHOzlKDlxh1InJSf - DansTon and Dentro Etichetta - Dish French',
  'kaGxVtjLwllv1bi2GFag': 'kaGxVtjLwllv1bi2GFag - Miltar Spektrum - German',
  'sai9UY7iXkRDSsXHR0bZ': 'sai9UY7iXkRDSsXHR0bZ - Loving wallaby',
  'H40kjYK5a0L22ZNpcFVB': 'H40kjYK5a0L22ZNpcFVB - Wosjko - Polish',
  'jccKWdITZiywXGZfLmCo': 'jccKWdITZiywXGZfLmCo - Ess Enthulit - Dish German',
  'iiidtqDt9FBdT1vfBluA': 'iiidtqDt9FBdT1vfBluA - Scurvy Dogs and bilge',
  'Dslrhjl3ZpzrctukrQSN': 'Dslrhjl3ZpzrctukrQSN - Asian Ancestry',
  '6M6w9bw1VlDEEDFeyrYu': '6M6w9bw1VlDEEDFeyrYu - Genesis Chamber',
  'QPBKI85w0cdXVqMSJ6WB': 'MAYSIE',
  'Cb8NLd0sUB8jI4MW2f9M': 'JEDEDIAH 1',
  'XwswTF89pZKbWpVX4A7R': 'Rune Dogs',
  'Z3R5wn05IrDiVCyEkUrK': 'ARABELLA',
  // AI84 clone name is the ElevenLabs ID itself (also caught by the id-in-name tier).
  'bfGb7JTLUnZebZRiFYyq': 'bfGb7JTLUnZebZRiFYyq',
  '4e32WqNVWRquDa1OcRYZ': '4e32WqNVWRquDa1OcRYZ',
  'DMyrgzQFny3JI1Y1paM5': 'DMyrgzQFny3JI1Y1paM5',
  'Nh2zY9kknu6z4pZy6FhD': 'Nh2zY9kknu6z4pZy6FhD',
  'fiRQs1f3h1NvmrcmdYpo': 'Moonlit german',
  '8z82LG47qQ2qjeeQB8lk': 'moonlit english',
  // AI84-only voices in the sheet (CHINESE, Natasha, SPANISH 1, SPANISH 2) have no
  // ElevenLabs ID, so they can't be keyed here — select them directly by AI84 voice.
};

// Cache AI84 voices so we don't fetch the list on every fallback call
let cachedVoices: AI84Voice[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface AI84Voice {
  canonical_voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
  language?: string;
  category?: string;
  labels?: Record<string, string>;
}

function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'xi-api-key': env.ai84.apiKey,
  };
}

// ── Voice Fetching & Matching ──

/**
 * Fetches user's cloned voices from AI84.pro.
 * Only cloned voices are used — system voices are not needed.
 * Caches for 30 minutes to avoid repeated calls.
 */
async function fetchAI84Voices(): Promise<AI84Voice[]> {
  if (cachedVoices && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedVoices;
  }

  console.log('[ai84] Fetching cloned voices...');

  try {
    const res = await fetch(`${BASE}/v1/minimax/voices/cloned`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[ai84] Failed to fetch cloned voices: ${res.status}`);
      return [];
    }

    const data = await res.json();
    cachedVoices = extractVoiceArray(data);
    cacheTimestamp = Date.now();
    console.log(`[ai84] Loaded ${cachedVoices.length} cloned voices`);
    return cachedVoices;
  } catch (err) {
    console.error('[ai84] Error fetching cloned voices:', err);
    return [];
  }
}

/** Extract voice array from various API response shapes. */
function extractVoiceArray(data: unknown): AI84Voice[] {
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.voices)) return obj.voices;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.results)) return obj.results;
  return [];
}

/**
 * Finds the best matching AI84 voice for a given 69 Labs / ElevenLabs voice ID.
 *
 * Matching priority (name/ID-based only — these confidently identify the voice):
 * 1. Hardcoded mapping (ELEVENLABS_TO_AI84_NAME) — matched by name in AI84 catalog
 * 2. AI84 voice name contains the ElevenLabs voice ID (cloned voices use ID in name)
 * 3. Exact canonical_voice_id match
 * 4. Exact name match (case-insensitive)
 * 5. Fuzzy name match + same gender
 *
 * Returns null if none of the above match. We deliberately do NOT fall back to a
 * gender match or "first available" voice: that silently substitutes an arbitrary
 * voice (and makes different source voiceIds collapse to the same wrong one, so
 * changing a channel's voice appears to do nothing). A null result lets the caller
 * fall back to 69 Labs, which uses the voiceId natively and correctly.
 */
async function findMatchingVoice(
  sourceVoiceId: string,
  sourceVoiceName?: string,
  sourceGender?: string
): Promise<string | null> {
  const voices = await fetchAI84Voices();

  if (voices.length === 0) {
    console.warn('[ai84] No voices available — no confident match, will fall back to 69 Labs');
    return null;
  }

  // 1. Hardcoded mapping — highest priority
  const mappedName = ELEVENLABS_TO_AI84_NAME[sourceVoiceId];
  if (mappedName) {
    const mappedNameLower = mappedName.toLowerCase();
    const mapped = voices.find((v) => v.name.toLowerCase() === mappedNameLower);
    if (mapped) {
      console.log(`[ai84] Hardcoded mapping hit: ${sourceVoiceId} → ${mapped.canonical_voice_id} (${mapped.name})`);
      return mapped.canonical_voice_id;
    }
    // Name didn't match exactly — try partial match (AI84 names can vary slightly)
    const partialMapped = voices.find((v) => {
      const n = v.name.toLowerCase();
      return n.includes(mappedNameLower) || mappedNameLower.includes(n);
    });
    if (partialMapped) {
      console.log(`[ai84] Hardcoded mapping (partial): ${sourceVoiceId} → ${partialMapped.canonical_voice_id} (${partialMapped.name})`);
      return partialMapped.canonical_voice_id;
    }
    console.warn(`[ai84] Hardcoded mapping name "${mappedName}" not found in AI84 catalog, falling through...`);
  }

  // 2. Search for ElevenLabs voice ID within AI84 voice names (cloned voices contain the ID)
  const idInName = voices.find((v) => v.name.includes(sourceVoiceId));
  if (idInName) {
    console.log(`[ai84] Voice ID found in AI84 name: ${idInName.canonical_voice_id} (${idInName.name})`);
    return idInName.canonical_voice_id;
  }

  // 3. Exact canonical_voice_id match
  const exactId = voices.find(
    (v) => v.canonical_voice_id === sourceVoiceId
  );
  if (exactId) {
    console.log(`[ai84] Exact ID match: ${exactId.canonical_voice_id} (${exactId.name})`);
    return exactId.canonical_voice_id;
  }

  // 4. Exact name match (case-insensitive)
  if (sourceVoiceName) {
    const nameLower = sourceVoiceName.toLowerCase();
    const exactName = voices.find(
      (v) => v.name.toLowerCase() === nameLower
    );
    if (exactName) {
      console.log(`[ai84] Exact name match: ${exactName.canonical_voice_id} (${exactName.name})`);
      return exactName.canonical_voice_id;
    }

    // 5. Fuzzy name match — check if the core name appears in AI84's voice name or vice versa
    const coreName = nameLower.split(/\s*[-–—:]\s*/)[0].trim();
    const fuzzyMatches = voices.filter((v) => {
      const ai84Name = v.name.toLowerCase();
      const ai84Core = ai84Name.split(/\s*[-–—:]\s*/)[0].trim();
      return ai84Core === coreName || ai84Name.includes(coreName) || coreName.includes(ai84Core);
    });

    if (fuzzyMatches.length > 0) {
      if (sourceGender) {
        const genderLower = sourceGender.toLowerCase();
        const genderMatch = fuzzyMatches.find((v) => {
          const vGender = (v.gender ?? v.labels?.gender ?? '').toLowerCase();
          return vGender === genderLower;
        });
        if (genderMatch) {
          console.log(`[ai84] Fuzzy name+gender match: ${genderMatch.canonical_voice_id} (${genderMatch.name})`);
          return genderMatch.canonical_voice_id;
        }
      }
      console.log(`[ai84] Fuzzy name match: ${fuzzyMatches[0].canonical_voice_id} (${fuzzyMatches[0].name})`);
      return fuzzyMatches[0].canonical_voice_id;
    }
  }

  // No confident (name/ID-based) match. Do NOT substitute a gender/first-available
  // voice — that would silently use the wrong voice. Return null so the caller falls
  // back to 69 Labs, which can use this voiceId directly.
  console.warn(`[ai84] No confident voice match for "${sourceVoiceName ?? sourceVoiceId}" (${sourceVoiceId}) — falling back to 69 Labs`);
  return null;
}

// ── TTS Generation ──

/**
 * Generates audio via AI84.pro async TTS.
 * Automatically matches the 69 Labs voice to an AI84 equivalent.
 *
 * @param sourceVoiceName - Name of the 69 Labs voice (for matching)
 * @param sourceGender - Gender of the 69 Labs voice (for matching)
 */
export async function generateAudio(
  text: string,
  config: VoiceConfig,
  onStageChange?: (stage: 'queued' | 'generating') => void,
  sourceVoiceName?: string,
  sourceGender?: string,
  cancelSignal?: AbortSignal
): Promise<Buffer> {
  // Resolve the matching AI84 voice ID
  const canonicalVoiceId = await findMatchingVoice(
    config.voiceId,
    sourceVoiceName,
    sourceGender
  );

  // No confident match — bail so the caller (voiceService) falls back to 69 Labs,
  // rather than generating audio in an arbitrary wrong voice.
  if (!canonicalVoiceId) {
    throw new Error(
      `AI84 has no confident voice match for "${sourceVoiceName ?? config.voiceId}" (${config.voiceId})`
    );
  }

  console.log(`[ai84] Starting TTS job with voice: ${canonicalVoiceId}`);

  // Step 1: Start async TTS job
  const startRes = await fetch(`${BASE}/v1/minimax/text-to-speech/async`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      canonical_voice_id: canonicalVoiceId,
      text,
      model: 'speech-2.6-turbo',
      speed: config.speed ?? 1.0,
      pitch: config.pitch ?? 1.0,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!startRes.ok) {
    const errorText = await startRes.text();
    throw new Error(`AI84 generate ${startRes.status}: ${errorText}`);
  }

  const startData = await startRes.json();
  const jobId = startData.job_id;

  if (!jobId) {
    // Check if audio was returned directly
    if (startData.audio_url) {
      return await downloadFromUrl(startData.audio_url);
    }
    throw new Error(
      `AI84: No job_id in response: ${JSON.stringify(startData).slice(0, 500)}`
    );
  }

  console.log(`[ai84] TTS job started: ${jobId}`);
  onStageChange?.('queued');

  // Step 2: Poll for completion
  return await pollAndDownload(jobId, onStageChange, cancelSignal);
}

// ── Async (resumable) API ──
// These let the caller START a job and CHECK it later from a different invocation,
// so a long AI84 queue/generation can span multiple cron runs without blocking.

/**
 * Starts an AI84 TTS job and returns its id immediately (no polling).
 * Throws if there's no confident voice match (so the caller can fall back to 69 Labs).
 */
export async function startJob(
  text: string,
  config: VoiceConfig,
  sourceVoiceName?: string,
  sourceGender?: string
): Promise<{ jobId: string; canonicalVoiceId: string }> {
  const canonicalVoiceId = await findMatchingVoice(config.voiceId, sourceVoiceName, sourceGender);
  if (!canonicalVoiceId) {
    throw new Error(
      `AI84 has no confident voice match for "${sourceVoiceName ?? config.voiceId}" (${config.voiceId})`
    );
  }

  const startRes = await fetch(`${BASE}/v1/minimax/text-to-speech/async`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      canonical_voice_id: canonicalVoiceId,
      text,
      model: 'speech-2.6-turbo',
      speed: config.speed ?? 1.0,
      pitch: config.pitch ?? 1.0,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!startRes.ok) {
    const errorText = await startRes.text();
    throw new Error(`AI84 generate ${startRes.status}: ${errorText}`);
  }

  const startData = await startRes.json();
  const jobId = startData.job_id;
  if (!jobId) {
    throw new Error(`AI84: No job_id in response: ${JSON.stringify(startData).slice(0, 500)}`);
  }

  console.log(`[ai84] Started job ${jobId} with voice ${canonicalVoiceId}`);
  return { jobId, canonicalVoiceId };
}

/**
 * Polls an AI84 job exactly once. Returns 'running' (keep waiting), 'done' (with the
 * downloaded audio), or 'failed'. Network blips are treated as 'running' so we retry
 * on the next cycle rather than failing the card.
 */
export async function checkJob(jobId: string, cancelSignal?: AbortSignal): Promise<TtsPollResult> {
  if (cancelSignal?.aborted) return { state: 'failed', error: 'Terminated by user' };

  let statusRes: Response;
  try {
    statusRes = await fetch(`${BASE}/v1/minimax/text-to-speech/async/${jobId}`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error(`[ai84] checkJob ${jobId} fetch error:`, err instanceof Error ? err.message : err);
    return { state: 'running' }; // transient — retry next cycle
  }

  if (!statusRes.ok) {
    const text = await statusRes.text();
    return { state: 'failed', error: `AI84 status ${statusRes.status}: ${text.slice(0, 200)}` };
  }

  const data = await statusRes.json();
  const parsed = interpretAi84Status(data, jobId);
  console.log(`[ai84] checkJob ${jobId}: ${parsed.state}${parsed.error ? ` (${parsed.error})` : ''}`);

  if (parsed.state === 'running') return { state: 'running' };
  if (parsed.state === 'failed') return { state: 'failed', error: parsed.error ?? 'AI84 job failed' };

  if (!parsed.audioUrl) {
    return { state: 'failed', error: `AI84 job ${jobId} reports done but no audio_url` };
  }
  try {
    const audio = await downloadFromUrl(parsed.audioUrl);
    return { state: 'done', audio };
  } catch (err) {
    return { state: 'failed', error: `AI84 download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Pure interpretation of an AI84 status payload. AI84 keeps status "queued" even while
 * working and may flip straight to complete, so the reliable done signals are: a populated
 * audio_url, a completed_at timestamp, or an explicit terminal-done status string.
 */
function interpretAi84Status(
  data: Record<string, unknown>,
  jobId: string
): { state: 'running' | 'done' | 'failed'; audioUrl?: string; error?: string } {
  const job = ((data.job ?? data) ?? {}) as Record<string, unknown>;
  const status = ((job.status ?? data.status ?? '') as string);
  const statusLower = status.toLowerCase();
  const audioUrl = (job.audio_url ?? job.download_url ?? job.url ?? job.output_url
    ?? data.audio_url ?? data.download_url ?? data.url) as string | undefined;
  const completedAt = (job.completed_at ?? data.completed_at) as string | null | undefined;

  const TERMINAL_FAIL = ['failed', 'error', 'errored', 'cancelled', 'canceled', 'rejected'];
  const TERMINAL_DONE = ['done', 'completed', 'complete', 'success', 'succeeded', 'finished', 'ready'];

  if (TERMINAL_FAIL.includes(statusLower) || job.failed_at) {
    const errMsg = (job.error_message ?? job.error ?? data.error ?? data.message ?? '') as string;
    return { state: 'failed', error: errMsg || `AI84 job ${jobId} failed` };
  }
  if (!!audioUrl || !!completedAt || TERMINAL_DONE.includes(statusLower)) {
    return { state: 'done', audioUrl };
  }
  return { state: 'running' };
}

/**
 * Polls AI84 job status until done, then downloads audio.
 */
async function pollAndDownload(
  jobId: string,
  onStageChange?: (stage: 'queued' | 'generating') => void,
  cancelSignal?: AbortSignal
): Promise<Buffer> {
  let lastStatus = '';
  let notifiedGenerating = false;
  let pollCount = 0;

  // Heartbeat: AI84's queue can run far longer than the stale-job cutoff. Re-emit the
  // current stage every ~60s so the card's updated_at stays fresh and the stale-job
  // recovery doesn't reset/fail a job that's still legitimately running.
  const HEARTBEAT_EVERY_POLLS = Math.max(1, Math.round(60000 / POLL_INTERVAL_MS));

  // Poll indefinitely until the TTS provider returns a terminal status.
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    // Check for cancellation after sleep (catches abort during wait)
    if (cancelSignal?.aborted) {
      throw new Error('Terminated by user');
    }

    if (pollCount % HEARTBEAT_EVERY_POLLS === 0) {
      onStageChange?.(notifiedGenerating ? 'generating' : 'queued');
    }

    let statusRes: Response;
    try {
      statusRes = await fetch(
        `${BASE}/v1/minimax/text-to-speech/async/${jobId}`,
        {
          headers: apiHeaders(),
          signal: AbortSignal.timeout(10000),
        }
      );
    } catch (fetchErr) {
      if (cancelSignal?.aborted) throw new Error('Terminated by user');
      console.error(`[ai84] Poll fetch error (attempt ${pollCount}):`, fetchErr);
      continue; // network glitch, keep polling
    }

    if (!statusRes.ok) {
      const text = await statusRes.text();
      throw new Error(`AI84 status check ${statusRes.status}: ${text}`);
    }

    const data = await statusRes.json();
    // AI84 nests job info under data.job (with top-level data.success)
    const job = (data.job ?? data) as Record<string, unknown>;
    const status = ((job.status ?? data.status ?? '') as string);
    const statusLower = status.toLowerCase();

    // Resolve a possible audio URL from any known field/shape.
    const audioUrl = (job.audio_url ?? job.download_url ?? job.url ?? job.output_url
      ?? data.audio_url ?? data.download_url ?? data.url) as string | undefined;

    if (status !== lastStatus || pollCount === 1) {
      const queuePos = job.queue_position != null ? ` (queue #${job.queue_position})` : '';
      const progress = job.progress != null ? ` progress: ${job.progress}%` : '';
      console.log(`[ai84] Job ${jobId} status: "${status}"${queuePos}${progress}`);
      // Log the full payload on first poll + each status change to debug status-string mismatches.
      console.log(`[ai84] Job ${jobId} raw status payload: ${JSON.stringify(data).slice(0, 800)}`);
      lastStatus = status;
    }

    const IN_PROGRESS = ['queued', 'pending', 'processing', 'running', 'in_progress', 'starting', 'waiting'];
    const TERMINAL_DONE = ['done', 'completed', 'complete', 'success', 'succeeded', 'finished', 'ready'];
    const TERMINAL_FAIL = ['failed', 'error', 'errored', 'cancelled', 'canceled', 'rejected'];

    const completedAt = (job.completed_at ?? data.completed_at) as string | null | undefined;
    const progressNum = typeof job.progress === 'number' ? (job.progress as number) : undefined;

    // Failed — check first so an error status can't be mistaken for success.
    if (TERMINAL_FAIL.includes(statusLower) || job.failed_at) {
      const errMsg = (job.error_message ?? job.error ?? data.error ?? data.message ?? '') as string;
      throw new Error(
        `AI84 TTS job failed: ${errMsg || JSON.stringify(data).slice(0, 300)}`
      );
    }

    // Done — AI84 keeps status "queued" even while working and may flip straight to
    // complete, so the reliable terminal signals are: a populated audio_url, a
    // completed_at timestamp, or an explicit terminal-done status string.
    const looksDone = !!audioUrl || !!completedAt || TERMINAL_DONE.includes(statusLower);

    if (looksDone) {
      if (!audioUrl) {
        throw new Error(
          `AI84 job ${jobId} reports done (status="${status}", completed_at=${completedAt}) but no audio_url: ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      console.log(`[ai84] Job ${jobId} done (status="${status}"), downloading audio...`);
      return await downloadFromUrl(audioUrl);
    }

    // In progress — advance the UI stage to "generating" once the job is actually
    // working. AI84 signals work via progress > 0 while status stays "queued", so
    // we key off progress as well as the processing/running statuses.
    if (!notifiedGenerating && (statusLower === 'processing' || statusLower === 'running' || (progressNum != null && progressNum > 0))) {
      notifiedGenerating = true;
      onStageChange?.('generating');
    }

    // Unknown, non-terminal state with no audio yet — log it but keep polling.
    if (statusLower && !IN_PROGRESS.includes(statusLower)) {
      console.warn(`[ai84] Job ${jobId} unknown state: "${status}" — continuing to poll`);
    }

    // queued / processing / running — keep polling
  }
}

/** Download audio from a URL. */
async function downloadFromUrl(url: string): Promise<Buffer> {
  console.log(`[ai84] Downloading audio from: ${url.slice(0, 100)}...`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    throw new Error(`AI84 audio download ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
