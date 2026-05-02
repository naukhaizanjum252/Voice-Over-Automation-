import { NextResponse } from 'next/server';
import { getBoards } from '@/services/trelloService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const boards = await getBoards();
    return NextResponse.json(boards);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
