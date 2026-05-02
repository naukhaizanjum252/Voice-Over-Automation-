import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { processAllChannels } from '@/services/processingService';

export async function GET(request: Request) {
  // Authenticate cron requests
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('x-cron-secret');

  if (secret !== env.cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
  }
}

// POST also accepted
export async function POST(request: Request) {
  return GET(request);
}
