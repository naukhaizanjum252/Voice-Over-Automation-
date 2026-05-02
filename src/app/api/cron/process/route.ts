import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { processAllChannels } from '@/services/processingService';

export const dynamic = 'force-dynamic';

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

// POST also accepted (GitHub Actions)
export async function POST(request: Request) {
  return GET(request);
}
