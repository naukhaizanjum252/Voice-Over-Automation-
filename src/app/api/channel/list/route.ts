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

    // Fetch processed cards — get recent cards for display + full counts via separate queries
    const { data: cards, error: cardErr } = await supabase
      .from('processed_cards')
      .select('*')
      .order('updated_at', { ascending: false })

    if (cardErr) {
      return NextResponse.json({ error: cardErr.message }, { status: 500 });
    }

    // Fetch accurate counts per channel via RPC or per-status count queries
    // Supabase count queries bypass the default 1000 row limit
    const statuses = ['completed', 'failed', 'processing', 'pending'] as const;
    const countMap = new Map<string, { total: number; completed: number; failed: number; processing: number }>();

    const countResults = await Promise.all(
      (channels ?? []).map(async (ch: Channel) => {
        const counts = await Promise.all(
          statuses.map(async (status) => {
            const { count } = await supabase
              .from('processed_cards')
              .select('*', { count: 'exact', head: true })
              .eq('channel_id', ch.id)
              .eq('status', status);
            return { status, count: count ?? 0 };
          })
        );
        const entry = { total: 0, completed: 0, failed: 0, processing: 0 };
        for (const c of counts) {
          entry.total += c.count;
          if (c.status === 'completed') entry.completed = c.count;
          else if (c.status === 'failed') entry.failed = c.count;
          else if (c.status === 'processing') entry.processing = c.count;
        }
        return { channelId: ch.id, entry };
      })
    );

    for (const { channelId, entry } of countResults) {
      countMap.set(channelId, entry);
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

    // Build stats per channel — use accurate counts from countMap, cards from the (capped) query for display
    const stats: ChannelStats[] = (channels ?? []).map((ch: Channel) => {
      const channelCards = (cards ?? []).filter(
        (c: ProcessedCard) => c.channel_id === ch.id
      );

      // Use accurate counts (not limited by Supabase row cap)
      const counts = countMap.get(ch.id) ?? { total: 0, completed: 0, failed: 0, processing: 0 };
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
        total: counts.total,
        completed: counts.completed,
        failed: counts.failed,
        processing: counts.processing,
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
