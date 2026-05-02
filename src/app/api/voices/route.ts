import { NextResponse } from 'next/server';
import { getVoices } from '@/services/voiceService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const voices = await getVoices();
    return NextResponse.json(voices);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
