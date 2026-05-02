import { NextResponse } from 'next/server';
import { retryCard } from '@/services/processingService';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cardId } = body;

    if (!cardId) {
      return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
    }

    const result = await retryCard(cardId);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
