import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { processChannel } from '@/services/processingService';
import type { Channel } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const supabase = getSupabase();
    const { data: channels, error } = await supabase
      .from('channels')
      .select('*');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!channels || channels.length === 0) {
      return NextResponse.json({ message: 'No channels found', results: [] });
    }

    const allResults = [];
    for (const channel of channels) {
      const results = await processChannel(channel as Channel);
      allResults.push(...results);
    }

    const succeeded = allResults.filter((r) => r.success).length;
    const failed = allResults.filter((r) => !r.success).length;

    return NextResponse.json({
      message: 'All channels processed',
      succeeded,
      failed,
      results: allResults,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
