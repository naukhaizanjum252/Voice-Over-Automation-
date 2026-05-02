import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { processChannel } from '@/services/processingService';
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

    const results = await processChannel(channel as Channel);
    return NextResponse.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Also allow GET for simpler triggers
export async function GET(request: Request) {
  return POST(request);
}
