import { NextResponse } from 'next/server';
import { getLists } from '@/services/trelloService';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const boardId = searchParams.get('boardId');

    if (!boardId || boardId === 'undefined' || boardId === 'null') {
      return NextResponse.json(
        { error: 'boardId is required', received: boardId },
        { status: 400 }
      );
    }

    const lists = await getLists(boardId);
    return NextResponse.json(lists);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/trello/lists] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
