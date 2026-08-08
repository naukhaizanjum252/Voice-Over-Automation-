import { env } from '@/lib/env';
import type { VoiceConfig, Voice, TtsJob, TtsProvider, TtsPollResult } from '@/types';
import { ELEVENLABS_VOICES } from '@/data/elevenlabs-voices';
import * as ai84Service from './ai84Service';

/**
 * All TTS runs through AI84 (https://api.ai84.pro). Two engines:
 *   - ai84_minimax     — MiniMax TTS via a cloned `canonical_voice_id`. Primary.
 *   - ai84_elevenlabs  — ElevenLabs TTS via the raw ElevenLabs `voice_id`. Fallback.
 *
 * Order is controlled by TTS_PRIMARY_PROVIDER: "elevenlabs" → ElevenLabs first;
 * anything else (default) → MiniMax first, ElevenLabs fallback.
 *
 * Note: MiniMax caps input at ~10k characters and needs a matching cloned voice, so
 * long scripts / unmatched voices fall through to the ElevenLabs engine automatically.
 */

/** Resolves the engine order from TTS_PRIMARY_PROVIDER (default: MiniMax → ElevenLabs). */
function resolveProviderOrder(): TtsProvider[] {
  const raw = (env.tts.primaryProvider || 'ai84').toLowerCase().trim();
  if (['elevenlabs', '11labs', 'eleven', '69labs', 'labs69'].includes(raw)) {
    return ['ai84_elevenlabs', 'ai84_minimax'];
  }
  return ['ai84_minimax', 'ai84_elevenlabs'];
}

/**
 * Resolves a voice's name + gender from the static ElevenLabs catalog so the MiniMax
 * engine can match it to a cloned `canonical_voice_id`. Synchronous — no network call.
 * The ElevenLabs engine ignores this (it uses the raw voiceId directly).
 */
function resolveSourceVoice(voiceId: string): { sourceName?: string; sourceGender?: string } {
  const sourceVoice = ELEVENLABS_VOICES.find((v) => v.voice_id === voiceId);
  if (sourceVoice) {
    console.log(`[voiceService] Source voice for MiniMax matching: "${sourceVoice.name}" (${sourceVoice.labels?.gender ?? 'unknown gender'})`);
    return { sourceName: sourceVoice.name, sourceGender: sourceVoice.labels?.gender };
  }
  console.log(`[voiceService] Source voice ${voiceId} not in static catalog — MiniMax will match by ID/hardcoded map`);
  return {};
}

// ── Async (resumable) TTS orchestration ──
// Start a job and persist its id; a later run polls it once and finishes when ready.

/**
 * Starts a TTS job on the first available AI84 engine (per TTS_PRIMARY_PROVIDER),
 * skipping any in `alreadyTried`. Returns a TtsJob to persist. Throws if none can start.
 */
export async function startTtsJob(
  text: string,
  config: VoiceConfig,
  alreadyTried: TtsProvider[] = []
): Promise<TtsJob> {
  if (!env.ai84.apiKey) {
    throw new Error('AI84_API_KEY is not set — TTS cannot run.');
  }

  const order = resolveProviderOrder().filter((p) => !alreadyTried.includes(p));
  const tried: TtsProvider[] = [...alreadyTried];
  const errors: string[] = [];

  for (const provider of order) {
    tried.push(provider);
    try {
      if (provider === 'ai84_minimax') {
        const { sourceName, sourceGender } = resolveSourceVoice(config.voiceId);
        const { jobId, canonicalVoiceId } = await ai84Service.startJob(text, config, sourceName, sourceGender);
        return { provider, jobId, voiceId: canonicalVoiceId, startedAt: new Date().toISOString(), triedProviders: tried };
      }
      // ai84_elevenlabs — uses the raw ElevenLabs voiceId directly.
      const { jobId } = await ai84Service.startElevenLabsJob(text, config);
      return { provider, jobId, voiceId: config.voiceId, startedAt: new Date().toISOString(), triedProviders: tried };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[voiceService] Failed to start ${provider}: ${msg}`);
      errors.push(`${provider}: ${msg}`);
    }
  }

  throw new Error(`Failed to start TTS on all AI84 engines. ${errors.join(' | ')}`);
}

/** Polls a persisted TTS job once, delegating to the engine that owns it. */
export async function pollTtsJob(job: TtsJob, cancelSignal?: AbortSignal): Promise<TtsPollResult> {
  if (job.provider === 'ai84_elevenlabs') {
    return ai84Service.checkElevenLabsJob(job.jobId, cancelSignal);
  }
  // ai84_minimax (and any legacy 'ai84' value) → MiniMax poller.
  return ai84Service.checkJob(job.jobId, cancelSignal);
}

// ── Voices (for the picker) ──

/**
 * Voices available in the picker: the static ElevenLabs catalog (usable directly by the
 * ElevenLabs engine) + the user's AI84 MiniMax cloned voices.
 */
export async function getVoices(): Promise<Voice[]> {
  const allVoices: Voice[] = [...ELEVENLABS_VOICES];

  try {
    const cloned = await ai84Service.listClonedVoices();
    for (const v of cloned) {
      if (!v.canonical_voice_id) continue;
      allVoices.push({
        voice_id: v.canonical_voice_id,
        name: v.name || 'Cloned voice',
        category: 'ai84-cloned',
      });
    }
  } catch (err) {
    console.error('[voiceService] AI84 cloned voices error:', err);
  }

  return allVoices;
}
