import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Fetch all channels
    const { data: channels, error: chErr } = await supabase
      .from('channels')
      .select('*')
      .order('created_at', { ascending: true });

    if (chErr) throw new Error(`Failed to fetch channels: ${chErr.message}`);

    // Fetch all processed cards
    const { data: cards, error: cardErr } = await supabase
      .from('processed_cards')
      .select('*')
      .order('created_at', { ascending: true });

    if (cardErr) throw new Error(`Failed to fetch cards: ${cardErr.message}`);

    // Build channels CSV
    const channelHeaders = ['id', 'name', 'trello_board_id', 'trello_list_ids', 'title_list_mappings', 'auto_run_enabled', 'voice_config', 'niche', 'format', 'length', 'character_count', 'output', 'note', 'feeder_scripts', 'created_at'];
    const channelRows = (channels || []).map((ch) =>
      channelHeaders.map((h) => {
        const val = ch[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      })
    );

    // Build cards CSV
    const cardHeaders = ['id', 'trello_card_id', 'card_name', 'channel_id', 'status', 'processing_stage', 'error_message', 'attachment_url', 'script_url', 'created_at', 'updated_at'];
    const cardRows = (cards || []).map((card) =>
      cardHeaders.map((h) => {
        const val = card[h];
        if (val === null || val === undefined) return '';
        return String(val);
      })
    );

    // Combine into a single CSV with section markers
    const lines: string[] = [];
    lines.push('## CHANNELS');
    lines.push(channelHeaders.map(escapeCsv).join(','));
    for (const row of channelRows) {
      lines.push(row.map(escapeCsv).join(','));
    }
    lines.push('');
    lines.push('## PROCESSED_CARDS');
    lines.push(cardHeaders.map(escapeCsv).join(','));
    for (const row of cardRows) {
      lines.push(row.map(escapeCsv).join(','));
    }

    const csv = lines.join('\n');
    const timestamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="voiceover_backup_${timestamp}.csv"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
