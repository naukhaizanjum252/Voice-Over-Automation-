import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const text = await request.text();
    const { channels, cards } = parseCsv(text);

    let channelsImported = 0;
    let cardsImported = 0;

    // Import channels
    if (channels.length > 0) {
      for (const row of channels) {
        const record: Record<string, unknown> = {
          id: row.id,
          name: row.name,
          trello_board_id: row.trello_board_id,
          trello_list_ids: parseJsonField(row.trello_list_ids, []),
          title_list_mappings: parseJsonField(row.title_list_mappings, []),
          auto_run_enabled: row.auto_run_enabled === 'true',
          voice_config: parseJsonField(row.voice_config, {}),
          niche: row.niche || null,
          format: row.format || null,
          length: row.length || null,
          character_count: row.character_count ? parseInt(row.character_count, 10) : null,
          output: row.output || null,
          note: row.note || null,
          feeder_scripts: parseJsonField(row.feeder_scripts, []),
          created_at: row.created_at || new Date().toISOString(),
        };

        const { error } = await supabase
          .from('channels')
          .upsert(record, { onConflict: 'id' });

        if (error) {
          console.error(`[import] Channel ${row.id} error:`, error.message);
        } else {
          channelsImported++;
        }
      }
    }

    // Import processed cards
    if (cards.length > 0) {
      for (const row of cards) {
        const record: Record<string, unknown> = {
          id: row.id,
          trello_card_id: row.trello_card_id,
          card_name: row.card_name || '',
          channel_id: row.channel_id,
          status: row.status || 'pending',
          processing_stage: row.processing_stage || null,
          error_message: row.error_message || null,
          attachment_url: row.attachment_url || null,
          script_url: row.script_url || null,
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
        };

        const { error } = await supabase
          .from('processed_cards')
          .upsert(record, { onConflict: 'id' });

        if (error) {
          console.error(`[import] Card ${row.id} error:`, error.message);
        } else {
          cardsImported++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      channelsImported,
      cardsImported,
      channelsTotal: channels.length,
      cardsTotal: cards.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function parseJsonField(value: string, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

interface ParsedCsv {
  channels: Record<string, string>[];
  cards: Record<string, string>[];
}

function parseCsv(text: string): ParsedCsv {
  const lines = text.split(/\r?\n/);
  const channels: Record<string, string>[] = [];
  const cards: Record<string, string>[] = [];

  let currentSection: 'channels' | 'cards' | null = null;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === '## CHANNELS') {
      currentSection = 'channels';
      headers = [];
      continue;
    }
    if (trimmed === '## PROCESSED_CARDS') {
      currentSection = 'cards';
      headers = [];
      continue;
    }

    if (!currentSection) continue;

    const values = parseCsvLine(trimmed);

    if (headers.length === 0) {
      headers = values;
      continue;
    }

    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] ?? '';
    }

    if (currentSection === 'channels') {
      channels.push(row);
    } else {
      cards.push(row);
    }
  }

  return { channels, cards };
}

/**
 * Parses a single CSV line respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        values.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  values.push(current);
  return values;
}
