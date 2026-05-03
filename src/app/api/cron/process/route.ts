import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { processAllChannels } from '@/services/processingService';
import { processAllScripts } from '@/services/scriptProcessingService';

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
    // Phase 1: Generate scripts for title cards
    console.log('[cron] Phase 1: Script generation...');
    const scriptResults = await processAllScripts();
    const scriptsOk = scriptResults.filter((r) => r.success).length;
    const scriptsFail = scriptResults.filter((r) => !r.success).length;
    console.log(`[cron] Scripts: ${scriptsOk} generated, ${scriptsFail} failed.`);

    // Phase 2: Generate voiceovers for script cards
    console.log('[cron] Phase 2: Voiceover processing...');
    const voiceResults = await processAllChannels();
    const voiceOk = voiceResults.filter((r) => r.success).length;
    const voiceFail = voiceResults.filter((r) => !r.success).length;
    console.log(`[cron] Voiceovers: ${voiceOk} succeeded, ${voiceFail} failed.`);

    return NextResponse.json({
      message: 'Processing complete',
      scripts: { succeeded: scriptsOk, failed: scriptsFail, results: scriptResults },
      voiceovers: { succeeded: voiceOk, failed: voiceFail, results: voiceResults },
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
