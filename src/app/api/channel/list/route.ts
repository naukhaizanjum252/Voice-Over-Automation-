import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getBoards, getLists } from '@/services/trelloService';
import type { ChannelStats, Channel, ProcessedCard, TitleListMappingResolved } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = getSupabase();

    // Fetch all channels
    const { data: channels, error: chErr } = await supabase
      .from('channels')
      .select('*')
      .order('created_at', { ascending: false });

    if (chErr) {
      return NextResponse.json({ error: chErr.message }, { status: 500 });
    }

    // Fetch all processed cards
    const { data: cards, error: cardErr } = await supabase
      .from('processed_cards')
      .select('*')
      .order('updated_at', { ascending: false });

    if (cardErr) {
      return NextResponse.json({ error: cardErr.message }, { status: 500 });
    }

    // Collect unique board IDs and fetch board + list names from Trello
    const boardIds = Array.from(new Set((channels ?? []).map((ch: Channel) => ch.trello_board_id)));

    // Fetch all boards once, then lists per board (in parallel)
    const [allBoards, ...listsPerBoard] = await Promise.all([
      getBoards(),
      ...boardIds.map((bid) => getLists(bid).catch(() => [])),
    ]);

    // Build lookup maps
    const boardNameMap = new Map(allBoards.map((b) => [b.id, b.name]));
    const listNameMap = new Map<string, string>();
    for (const lists of listsPerBoard) {
      for (const l of lists) {
        listNameMap.set(l.id, l.name);
      }
    }

    // Build stats per channel
    const stats: ChannelStats[] = (channels ?? []).map((ch: Channel) => {
      const channelCards = (cards ?? []).filter(
        (c: ProcessedCard) => c.channel_id === ch.id
      );

      const completed = channelCards.filter((c: ProcessedCard) => c.status === 'completed').length;
      const failed = channelCards.filter((c: ProcessedCard) => c.status === 'failed').length;
      const processing = channelCards.filter((c: ProcessedCard) => c.status === 'processing' || c.status === 'pending').length;
      const lastRun = channelCards.length > 0 ? channelCards[0].updated_at : null;

      return {
        channel: ch,
        boardName: boardNameMap.get(ch.trello_board_id) ?? ch.trello_board_id,
        listNames: ch.trello_list_ids.map((lid) => listNameMap.get(lid) ?? lid),
        titleListMappings: (ch.title_list_mappings ?? []).map((m: { titleListId: string; voiceoverListId: string }): TitleListMappingResolved => ({
          titleListId: m.titleListId,
          titleListName: listNameMap.get(m.titleListId) ?? m.titleListId,
          voiceoverListId: m.voiceoverListId,
          voiceoverListName: listNameMap.get(m.voiceoverListId) ?? m.voiceoverListId,
        })),
        total: channelCards.length,
        completed,
        failed,
        processing,
        lastRun,
        cards: channelCards,
      };
    });

    return NextResponse.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
