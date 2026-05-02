import { env } from '@/lib/env';
import type { VoiceConfig, Voice } from '@/types';
import { ELEVENLABS_VOICES } from '@/data/elevenlabs-voices';

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
 */
const BASE = 'https://69labs.vip/api/v1';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const TTS_POLL_INTERVAL_MS = 2000;
const TTS_POLL_MAX_ATTEMPTS = 60; // 2 min max wait

function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${env.labs69.apiKey}`,
  };
}

// ── TTS (async: generate → poll → download) ──

/**
 * Generates audio for a single text chunk using 69 Labs async TTS.
 * 1. POST /voice-clones/generate  → start job
 * 2. Poll GET /tts/status/{id}    → wait for completion
 * 3. GET  /tts/download/{id}      → download audio
 */
export async function generateAudio(
  text: string,
  config: VoiceConfig
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
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!generateRes.ok) {
        const errorText = await generateRes.text();
        throw new Error(`69 Labs generate ${generateRes.status}: ${errorText}`);
      }

      const generateData = await generateRes.json();
      const jobId =
        generateData.id ?? generateData.jobId ?? generateData.task_id;

      if (!jobId) {
        // Some endpoints return audio directly
        if (generateData.audio_url) {
          return await downloadFromUrl(generateData.audio_url);
        }
        throw new Error(
          `No job ID in generate response: ${JSON.stringify(generateData).slice(0, 300)}`
        );
      }

      console.log(`[voiceService] TTS job started: ${jobId}`);

      // Step 2: Poll → Step 3: Download
      return await pollAndDownload(jobId);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[voiceService] Attempt ${attempt}/${MAX_RETRIES} failed:`,
        lastError.message
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error('Voice generation failed after retries');
}

/**
 * Polls TTS job status until complete, then downloads the audio.
 */
async function pollAndDownload(jobId: string): Promise<Buffer> {
  for (let i = 0; i < TTS_POLL_MAX_ATTEMPTS; i++) {
    await sleep(TTS_POLL_INTERVAL_MS);

    const statusRes = await fetch(`${BASE}/tts/status/${jobId}`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (!statusRes.ok) {
      const text = await statusRes.text();
      throw new Error(`TTS status check ${statusRes.status}: ${text}`);
    }

    const status = await statusRes.json();
    const state: string =
      (status.status ?? status.state ?? '') as string;

    console.log(`[voiceService] Job ${jobId}: ${state}`);

    if (['completed', 'done', 'ready'].includes(state.toLowerCase())) {
      // If status response includes a download URL, use it
      const downloadUrl = status.download_url ?? status.audio_url ?? status.url;
      if (downloadUrl) {
        return await downloadFromUrl(downloadUrl as string);
      }
      // Otherwise hit the standard download endpoint
      return await downloadTTS(jobId);
    }

    if (['failed', 'error'].includes(state.toLowerCase())) {
      throw new Error(
        `TTS job failed: ${status.error ?? status.message ?? JSON.stringify(status)}`
      );
    }
  }

  throw new Error(
    `TTS job ${jobId} timed out after ${TTS_POLL_MAX_ATTEMPTS * TTS_POLL_INTERVAL_MS / 1000}s`
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
