import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { processChannel } from '@/services/processingService';
import { processChannelScripts } from '@/services/scriptProcessingService';
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

    // Phase 1: Generate scripts for all channels with title lists
    // Fetch primary docs once for all channels
    const { fetchPrimaryDocTexts } = await import('@/services/scriptProcessingService');
    const primaryDocTexts = await fetchPrimaryDocTexts();
    const scriptResults = [];
    for (const channel of channels) {
      const ch = channel as Channel;
      if (ch.title_list_mappings && ch.title_list_mappings.length > 0) {
        const results = await processChannelScripts(ch, primaryDocTexts);
        scriptResults.push(...results);
      }
    }

    // Phase 2: Generate voiceovers for all channels
    const voiceResults = [];
    for (const channel of channels) {
      const results = await processChannel(channel as Channel);
      voiceResults.push(...results);
    }

    return NextResponse.json({
      message: 'All channels processed',
      scripts: {
        succeeded: scriptResults.filter((r) => r.success).length,
        failed: scriptResults.filter((r) => !r.success).length,
        results: scriptResults,
      },
      voiceovers: {
        succeeded: voiceResults.filter((r) => r.success).length,
        failed: voiceResults.filter((r) => !r.success).length,
        results: voiceResults,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
