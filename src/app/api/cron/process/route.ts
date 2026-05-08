import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { processAllChannels } from '@/services/processingService';

export const dynamic = 'force-dynamic';

const LOCK_NAME = 'cron_process';
const LOCK_STALE_MINUTES = 30; // Force-release lock after this long (crash recovery)

/**
 * Acquires a distributed lock via Supabase.
 * Returns true if lock acquired, false if another run is in progress.
 * Stale locks (older than LOCK_STALE_MINUTES) are force-released.
 */
async function acquireLock(): Promise<boolean> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();

  // Delete any stale locks first (crashed runs that never released)
  await supabase
    .from('cron_locks')
    .delete()
    .eq('lock_name', LOCK_NAME)
    .lt('locked_at', staleCutoff);

  // Try to insert our lock — unique constraint on lock_name will reject duplicates
  const { error } = await supabase
    .from('cron_locks')
    .insert({ lock_name: LOCK_NAME, locked_at: now.toISOString() });

  if (error) {
    // Unique violation = another run holds the lock
    if (error.code === '23505') return false;
    // Other error — log but allow the run (fail-open)
    console.error('[cron-lock] Unexpected error acquiring lock:', error.message);
    return true;
  }

  return true;
}

/** Releases the cron lock. */
async function releaseLock(): Promise<void> {
  const { error } = await supabase
    .from('cron_locks')
    .delete()
    .eq('lock_name', LOCK_NAME);

  if (error) {
    console.error('[cron-lock] Failed to release lock:', error.message);
  }
}

export async function GET(request: Request) {
  // Authenticate: accept secret from query param, headers, or Vercel cron user-agent
  const { searchParams } = new URL(request.url);
  const authHeader = request.headers.get('authorization');
  const userAgent = request.headers.get('user-agent') || '';

  const secret = searchParams.get('secret')
    || request.headers.get('x-cron-secret')
    || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  const isVercelCron = userAgent.startsWith('vercel-cron');

  if (!isVercelCron && secret !== env.cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Acquire distributed lock — skip if another run is in progress
  const locked = await acquireLock();
  if (!locked) {
    console.log('[cron] Skipping — another cron run is still in progress.');
    return NextResponse.json({ message: 'Skipped — previous run still in progress' }, { status: 200 });
  }

  try {
    console.log('[cron] Starting processing run...');
    const results = await processAllChannels();
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`[cron] Done. ${succeeded} succeeded, ${failed} failed.`);
    return NextResponse.json({
      message: 'Processing complete',
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[cron] Fatal error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // Always release the lock, even on error
    await releaseLock();
  }
}

// POST also accepted (GitHub Actions)
export async function POST(request: Request) {
  return GET(request);
}
