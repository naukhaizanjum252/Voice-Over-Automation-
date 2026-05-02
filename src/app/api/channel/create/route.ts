import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, trello_board_id, trello_list_ids, auto_run_enabled, voice_config } = body;

    if (!name || !trello_board_id || !trello_list_ids?.length) {
      return NextResponse.json(
        { error: 'name, trello_board_id, and trello_list_ids are required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('channels')
      .insert({
        name,
        trello_board_id,
        trello_list_ids,
        auto_run_enabled: auto_run_enabled ?? true,
        voice_config: voice_config ?? {
          voiceId: 'EXAVITQu4vr4xnSDxMaL', // default voice
          speed: 1.0,
          pitch: 1.0,
          stability: 0.5,
        },
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
