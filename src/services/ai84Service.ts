import { env } from '@/lib/env';
import type { VoiceConfig } from '@/types';

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
const POLL_MAX_ATTEMPTS = 60; // ~5 min max wait

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
 * Matching priority:
 * 1. Hardcoded mapping (ELEVENLABS_TO_AI84_NAME) — matched by name in AI84 catalog
 * 2. AI84 voice name contains the ElevenLabs voice ID (cloned voices use ID in name)
 * 3. Exact canonical_voice_id match
 * 4. Exact name match (case-insensitive)
 * 5. Fuzzy name match + same gender
 * 6. Same gender match (pick first)
 * 7. First available voice as last resort
 */
async function findMatchingVoice(
  sourceVoiceId: string,
  sourceVoiceName?: string,
  sourceGender?: string
): Promise<string> {
  const voices = await fetchAI84Voices();

  if (voices.length === 0) {
    console.warn('[ai84] No voices available, using original voiceId as-is');
    return sourceVoiceId;
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

  // 6. Gender match — pick first voice with same gender
  if (sourceGender) {
    const genderLower = sourceGender.toLowerCase();
    const genderMatch = voices.find((v) => {
      const vGender = (v.gender ?? v.labels?.gender ?? '').toLowerCase();
      return vGender === genderLower;
    });
    if (genderMatch) {
      console.log(`[ai84] Gender match: ${genderMatch.canonical_voice_id} (${genderMatch.name})`);
      return genderMatch.canonical_voice_id;
    }
  }

  // 7. Last resort — first voice
  console.log(`[ai84] No match found, using first available: ${voices[0].canonical_voice_id} (${voices[0].name})`);
  return voices[0].canonical_voice_id;
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
  sourceGender?: string
): Promise<Buffer> {
  // Resolve the matching AI84 voice ID
  const canonicalVoiceId = await findMatchingVoice(
    config.voiceId,
    sourceVoiceName,
    sourceGender
  );

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
  return await pollAndDownload(jobId, onStageChange);
}

/**
 * Polls AI84 job status until done, then downloads audio.
 */
async function pollAndDownload(
  jobId: string,
  onStageChange?: (stage: 'queued' | 'generating') => void
): Promise<Buffer> {
  let lastStatus = '';
  let notifiedGenerating = false;

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);

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
      console.error(`[ai84] Poll fetch error (attempt ${i + 1}):`, fetchErr);
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

    if (status !== lastStatus || i === 0) {
      const queuePos = job.queue_position != null ? ` (queue #${job.queue_position})` : '';
      const progress = job.progress != null ? ` progress: ${job.progress}%` : '';
      console.log(`[ai84] Job ${jobId} status: "${status}"${queuePos}${progress}`);
      lastStatus = status;
    }

    // Done — download audio
    if (statusLower === 'done' || statusLower === 'completed' || statusLower === 'success') {
      const audioUrl = (job.audio_url ?? job.download_url ?? data.audio_url ?? data.url) as string | null;
      if (!audioUrl) {
        throw new Error(
          `AI84 job done but no audio_url: ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      console.log(`[ai84] Job ${jobId} done, downloading audio...`);
      return await downloadFromUrl(audioUrl);
    }

    // Failed
    if (statusLower === 'failed' || statusLower === 'error' || statusLower === 'cancelled') {
      const errMsg = (job.error_message ?? job.error ?? data.error ?? data.message ?? '') as string;
      throw new Error(
        `AI84 TTS job failed: ${errMsg || JSON.stringify(data).slice(0, 300)}`
      );
    }

    // In progress — notify generating stage
    if (!notifiedGenerating && (statusLower === 'processing' || statusLower === 'running')) {
      notifiedGenerating = true;
      onStageChange?.('generating');
    }

    // queued / processing / running — keep polling
  }

  throw new Error(
    `AI84 TTS job ${jobId} timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Last status: "${lastStatus}"`
  );
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
