// ── Standalone processing worker (for VPS / any long-running host) ──
//
// Why this exists: on Vercel, /api/cron/process runs both phases inside one
// time-boxed serverless function. A long script generation exhausts that budget and
// the function is KILLED mid-run, which (a) freezes cards and (b) leaks the cron lock.
// This worker runs the exact same processing logic as an ordinary long-lived Node
// process — no per-request kill, so long-form (high max_tokens) generations can finish.
//
// It also DECOUPLES the two phases: script generation and audio finishing run as two
// independent loops, so a slow script run can never starve the audio pipeline (which is
// the only code that pulls finished TTS jobs back from AI84/69 Labs and marks them done).
//
// Run a SINGLE instance. When the worker is live, disable the Vercel/GitHub cron so the
// two don't both process the same DB (the worker does not use the cron_locks lock).

import './load-env'; // must be first — fills process.env before @/lib/env is evaluated
import { processAllScripts } from '@/services/scriptProcessingService';
import { processAllChannels } from '@/services/processingService';
import type { ProcessingResult } from '@/types';

// Audio finishing should run often (it's cheap and it's what completes stuck jobs).
// Script generation runs less often (it's heavy).
const AUDIO_INTERVAL_MS = Number(process.env.WORKER_AUDIO_INTERVAL_MS ?? 60_000);       // 1 min
const SCRIPT_INTERVAL_MS = Number(process.env.WORKER_SCRIPT_INTERVAL_MS ?? 5 * 60_000); // 5 min

let stopping = false;

function log(scope: string, msg: string): void {
  console.log(`[worker:${scope}] ${new Date().toISOString()} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tally(scope: string, results: ProcessingResult[]): void {
  const ok = results.filter((r) => r.success).length;
  const fail = results.length - ok;
  log(scope, `run complete — ${ok} ok, ${fail} failed`);
}

/**
 * Runs `fn` forever on a fixed interval. Never overlaps itself (waits for the previous
 * run to finish, then sleeps the remainder of the interval). Isolated from the other
 * loop — a throw here never stops the other loop or the process.
 */
async function loop(scope: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      log(scope, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopping) break;
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
  log(scope, 'stopped');
}

async function main(): Promise<void> {
  log('main', `starting — audio every ${AUDIO_INTERVAL_MS}ms, scripts every ${SCRIPT_INTERVAL_MS}ms`);

  await Promise.all([
    loop('audio', AUDIO_INTERVAL_MS, async () => {
      tally('audio', await processAllChannels());
    }),
    loop('scripts', SCRIPT_INTERVAL_MS, async () => {
      tally('scripts', await processAllScripts());
    }),
  ]);

  log('main', 'all loops stopped — exiting');
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    log('main', `${sig} received — finishing in-flight work, then exiting`);
    stopping = true;
  });
}

main().catch((err) => {
  log('main', `fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
