import { NextResponse } from 'next/server';
import { manualRunFull, manualRunVoiceover } from '@/services/processingService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cardId, action } = body as { cardId?: string; action?: string };

    if (!cardId) {
      return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
    }

    if (!action || !['full', 'voiceover'].includes(action)) {
      return NextResponse.json(
        { error: 'action is required and must be "full" or "voiceover"' },
        { status: 400 }
      );
    }

    const result =
      action === 'full'
        ? await manualRunFull(cardId)
        : await manualRunVoiceover(cardId);

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
