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

    // Phase 1: Generate scripts (if title list mappings configured)
    let scriptResults: { cardId: string; cardName: string; success: boolean; error?: string }[] = [];
    if (ch.title_list_mappings && ch.title_list_mappings.length > 0) {
      const { fetchPrimaryDocTexts } = await import('@/services/scriptProcessingService');
      const primaryDocTexts = await fetchPrimaryDocTexts();

      // Fetch configured model
      const { data: modelSetting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'script_model')
        .single();
      const scriptModel = modelSetting?.value || undefined;

      scriptResults = await processChannelScripts(ch, primaryDocTexts, scriptModel);
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
