import { env } from '@/lib/env';
import type { VoiceConfig, Voice } from '@/types';
import { ELEVENLABS_VOICES } from '@/data/elevenlabs-voices';
import * as ai84Service from './ai84Service';

/**
 * 69 Labs External API
 * Base: https://69labs.vip/api/v1
 * Auth: Authorization: Bearer <vk_ API key> (permanent, no refresh needed)
 *
 * Voices:
 *   GET  /voice-clones          → your cloned voices
 *   GET  /voice-clones/library  → shared/global voice library
 *
 * TTS (async):
 *   POST /voice-clones/generate → returns job { id }
 *   GET  /tts/status/{id}       → poll until ready
 *   GET  /tts/download/{id}     → download audio file
 *
 * Fallback: AI84.pro — used when 69 Labs fails or doesn't respond.
 */
const BASE = 'https://69labs.vip/api/v1';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const TTS_POLL_INTERVAL_MS = 5000;
const TTS_POLL_MAX_ATTEMPTS = 24; // ~2 min max wait

function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${env.labs69.apiKey}`,
  };
}

// ── TTS with automatic fallback ──

/**
 * Generates audio using 69 Labs as primary, AI84.pro as fallback.
 * Falls back when 69 Labs throws any error or times out.
 */
export async function generateAudio(
  text: string,
  config: VoiceConfig,
  onStageChange?: (stage: 'queued' | 'generating') => void,
  cancelSignal?: AbortSignal
): Promise<Buffer> {
  try {
    return await generateAudioWith69Labs(text, config, onStageChange, cancelSignal);
  } catch (primaryError) {
    // If cancelled, don't fall back — propagate immediately
    if (cancelSignal?.aborted) throw primaryError;

    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.error(`[voiceService] 69 Labs failed: ${errMsg}`);

    // Check if AI84 fallback is configured
    if (!env.ai84.apiKey) {
      console.error('[voiceService] AI84 fallback not configured (no API key). Re-throwing 69 Labs error.');
      throw primaryError;
    }

    console.log('[voiceService] Falling back to AI84.pro...');

    // Look up the source voice name and gender so AI84 can find the best match
    let sourceName: string | undefined;
    let sourceGender: string | undefined;
    try {
      const allVoices = await getVoices();
      const sourceVoice = allVoices.find((v) => v.voice_id === config.voiceId);
      if (sourceVoice) {
        sourceName = sourceVoice.name;
        sourceGender = sourceVoice.labels?.gender;
        console.log(`[voiceService] Source voice for matching: "${sourceName}" (${sourceGender ?? 'unknown gender'})`);
      }
    } catch {
      console.warn('[voiceService] Could not fetch source voice info for matching');
    }

    try {
      const audio = await ai84Service.generateAudio(text, config, onStageChange, sourceName, sourceGender, cancelSignal);
      console.log('[voiceService] AI84 fallback succeeded.');
      return audio;
    } catch (fallbackError) {
      if (cancelSignal?.aborted) throw fallbackError;
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`[voiceService] AI84 fallback also failed: ${fallbackMsg}`);
      throw new Error(
        `TTS failed on both providers. 69 Labs: ${errMsg} | AI84: ${fallbackMsg}`
      );
    }
  }
}

/**
 * Generates audio using 69 Labs async TTS (primary provider).
 * 1. POST /tts/generate  → start job
 * 2. Poll GET /tts/status/{id}    → wait for completion
 * 3. GET  /tts/download/{id}      → download audio
 */
async function generateAudioWith69Labs(
  text: string,
  config: VoiceConfig,
  onStageChange?: (stage: 'queued' | 'generating') => void,
  cancelSignal?: AbortSignal
): Promise<Buffer> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Step 1: Start TTS job
      const generateRes = await fetch(`${BASE}/tts/generate`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          text,
          voiceId: config.voiceId,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: config.stability,
            similarity_boost: 0.75,
            speed: config.speed,
            style: config.style ?? 0,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!generateRes.ok) {
        const errorText = await generateRes.text();
        const err = new Error(`69 Labs generate ${generateRes.status}: ${errorText}`);
        // Don't retry on 400/401/403 — these are permanent failures
        if (generateRes.status >= 400 && generateRes.status < 500) {
          throw err;
        }
        throw err;
      }

      const generateData = await generateRes.json();
      console.log(`[voiceService] Generate response keys: ${Object.keys(generateData).join(', ')}`);

      const jobId =
        generateData.id ?? generateData.jobId ?? generateData.task_id ?? generateData.ttsId;

      if (!jobId) {
        // Some endpoints return audio directly
        if (generateData.audio_url) {
          return await downloadFromUrl(generateData.audio_url);
        }
        // If response has audio data inline
        if (generateData.audio) {
          return Buffer.from(generateData.audio, 'base64');
        }
        throw new Error(
          `No job ID in generate response: ${JSON.stringify(generateData).slice(0, 500)}`
        );
      }

      console.log(`[voiceService] TTS job started: ${jobId}`);

      // Step 2: Poll → Step 3: Download
      return await pollAndDownload(jobId, onStageChange, cancelSignal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[voiceService] 69 Labs attempt ${attempt}/${MAX_RETRIES} failed:`,
        lastError.message
      );

      // Don't retry on client errors (4xx) — they won't succeed on retry
      if (lastError.message.includes(' 400:') || lastError.message.includes(' 401:') ||
          lastError.message.includes(' 403:') || lastError.message.includes(' 404:')) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error('69 Labs voice generation failed after retries');
}

/**
 * Polls TTS job status until complete, then downloads the audio.
 */
async function pollAndDownload(
  jobId: string,
  onStageChange?: (stage: 'queued' | 'generating') => void,
  cancelSignal?: AbortSignal
): Promise<Buffer> {
  let lastState = '';
  let notifiedGenerating = false;

  for (let i = 0; i < TTS_POLL_MAX_ATTEMPTS; i++) {
    await sleep(TTS_POLL_INTERVAL_MS);

    // Check for cancellation after sleep (catches abort during wait)
    if (cancelSignal?.aborted) {
      throw new Error('Terminated by user');
    }

    let statusRes: Response;
    try {
      statusRes = await fetch(`${BASE}/tts/status/${jobId}`, {
        headers: apiHeaders(),
        signal: AbortSignal.timeout(10000),
      });
    } catch (fetchErr) {
      if (cancelSignal?.aborted) throw new Error('Terminated by user');
      console.error(`[voiceService] Poll fetch error (attempt ${i + 1}):`, fetchErr);
      continue; // network glitch, keep polling
    }

    if (!statusRes.ok) {
      const text = await statusRes.text();
      // 404 might mean the job doesn't exist or endpoint is wrong
      if (statusRes.status === 404) {
        console.error(`[voiceService] Job ${jobId} not found (404), trying download directly...`);
        try {
          return await downloadTTS(jobId);
        } catch {
          throw new Error(`TTS job ${jobId} not found and download failed`);
        }
      }
      throw new Error(`TTS status check ${statusRes.status}: ${text}`);
    }

    const status = await statusRes.json();
    const state: string =
      (status.status ?? status.state ?? '') as string;
    const queuePos = status.queuePosition;

    // Log on first poll or state change
    if (state !== lastState || i === 0) {
      const queueInfo = queuePos != null ? ` (queue #${queuePos})` : '';
      console.log(`[voiceService] Job ${jobId} state: "${state}"${queueInfo} | startedAt: ${status.startedAt ?? 'null'}`);
      lastState = state;
    }

    const stateLower = state.toLowerCase();

    if (['completed', 'done', 'ready', 'success'].includes(stateLower)) {
      // Check for download URL in status response or outputMetadata
      const meta = status.outputMetadata as Record<string, unknown> | null;
      const downloadUrl = status.download_url ?? status.audio_url ?? status.url
        ?? status.outputUrl ?? meta?.url ?? meta?.audioUrl;
      if (downloadUrl) {
        return await downloadFromUrl(downloadUrl as string);
      }
      return await downloadTTS(jobId);
    }

    if (['failed', 'error', 'cancelled', 'canceled'].includes(stateLower)) {
      throw new Error(
        `TTS job failed: ${status.error ?? status.message ?? status.errorMessage ?? JSON.stringify(status).slice(0, 300)}`
      );
    }

    // PENDING / PROCESSING are expected in-progress states — keep polling
    if (['pending', 'processing', 'queued', 'running'].includes(stateLower)) {
      // Notify UI when job moves from queued/pending to actively processing
      if (!notifiedGenerating && ['processing', 'running'].includes(stateLower)) {
        notifiedGenerating = true;
        onStageChange?.('generating');
      }
      continue;
    }

    // Unknown state — log it but keep polling
    if (stateLower) {
      console.warn(`[voiceService] Job ${jobId} unknown state: "${state}" — continuing to poll`);
    }

    // If state is empty after 30 seconds, something's wrong
    if (!stateLower && i >= 6) {
      throw new Error(
        `TTS job ${jobId} returned empty status after ${i * TTS_POLL_INTERVAL_MS / 1000}s. Response: ${JSON.stringify(status).slice(0, 300)}`
      );
    }
  }

  throw new Error(
    `TTS job ${jobId} timed out after ${TTS_POLL_MAX_ATTEMPTS * TTS_POLL_INTERVAL_MS / 1000}s. Last state: "${lastState}"`
  );
}

/** Download finished TTS audio by job ID. */
async function downloadTTS(jobId: string): Promise<Buffer> {
  const res = await fetch(`${BASE}/tts/download/${jobId}`, {
    headers: {
      Authorization: `Bearer ${env.labs69.apiKey}`,
      Accept: 'audio/mpeg',
    },
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TTS download ${res.status}: ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Download audio from a direct URL. */
async function downloadFromUrl(url: string): Promise<Buffer> {
  const fullUrl = url.startsWith('http')
    ? url
    : `https://69labs.vip${url}`;

  const res = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${env.labs69.apiKey}` },
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw new Error(`Audio download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Batch generation ──

/**
 * Generates audio for all chunks sequentially.
 */
export async function generateAllChunks(
  chunks: string[],
  config: VoiceConfig
): Promise<Buffer[]> {
  const buffers: Buffer[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(
      `[voiceService] Generating chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`
    );
    const audio = await generateAudio(chunks[i], config);
    buffers.push(audio);

    if (i < chunks.length - 1) {
      await sleep(500);
    }
  }

  return buffers;
}

// ── Voices ──

/**
 * Fetches all available voices.
 * Combines: 1599 ElevenLabs voices (static catalog) + user's 69 Labs cloned voices.
 */
export async function getVoices(): Promise<Voice[]> {
  const allVoices: Voice[] = [];

  // 1. ElevenLabs voice catalog (1599 voices, static import)
  allVoices.push(...ELEVENLABS_VOICES);

  // 2. User's own 69 Labs cloned voices
  try {
    const res = await fetch(`${BASE}/voice-clones`, {
      headers: apiHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = await res.json();
      const arr = extractVoiceArray(data);

      for (const v of arr) {
        allVoices.push(mapVoice(v, 'cloned'));
      }
    }
  } catch (err) {
    console.error('[voiceService] Cloned voices error:', err);
  }

  // 3. 69 Labs shared library voices
  try {
    const res = await fetch(`${BASE}/voice-clones/library`, {
      headers: apiHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = await res.json();
      const arr = extractVoiceArray(data);

      for (const v of arr) {
        allVoices.push(mapVoice(v, 'shared'));
      }
    }
  } catch (err) {
    console.error('[voiceService] Library voices error:', err);
  }

  return allVoices;
}

/** Extract voice array from various response shapes. */
function extractVoiceArray(
  data: unknown
): Record<string, unknown>[] {
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.voiceClones)) return obj.voiceClones;
  if (Array.isArray(obj.voices)) return obj.voices;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

/** Map a raw voice object to our Voice type. */
function mapVoice(
  v: Record<string, unknown>,
  fallbackCategory: string
): Voice {
  // Build labels from flat fields if not already present
  const existingLabels = v.labels as Record<string, string> | undefined;
  const labels: Record<string, string> = existingLabels
    ? { ...existingLabels }
    : {};

  // 69 Labs returns gender/language at top level
  if (v.gender && !labels.gender) labels.gender = String(v.gender);
  if (v.language && !labels.accent) labels.accent = String(v.language);
  if (v.isGlobal !== undefined) {
    labels.use_case = v.isGlobal ? 'global' : 'custom';
  }

  return {
    voice_id: (v.voice_id ?? v.voiceId ?? v.id ?? '') as string,
    name: (v.name ?? 'Unknown') as string,
    category: (v.category ?? fallbackCategory) as string,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
    preview_url: (v.preview_url ?? v.previewUrl ?? v.sample_url) as
      | string
      | undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
