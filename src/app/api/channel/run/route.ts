import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { processChannel } from '@/services/processingService';
import { processChannelScripts } from '@/services/scriptProcessingService';
import type { Channel } from '@/types';

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  try {
    const { data: channel, error } = await supabase
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .single();

    if (error || !channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    const ch = channel as Channel;

    // Phase 1: Generate scripts (if title list + master prompt configured)
    let scriptResults: { cardId: string; cardName: string; success: boolean; error?: string }[] = [];
    if (ch.trello_title_list_id && ch.master_prompt) {
      scriptResults = await processChannelScripts(ch);
    }

    // Phase 2: Generate voiceovers
    const voiceResults = await processChannel(ch);

    return NextResponse.json({
      scripts: scriptResults,
      voiceovers: voiceResults,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Also allow GET for simpler triggers
export async function GET(request: Request) {
  return POST(request);
}
