import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { id, name, trello_board_id, trello_list_ids, auto_run_enabled, voice_config } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    if (!name || !trello_board_id || !trello_list_ids?.length) {
      return NextResponse.json(
        { error: 'name, trello_board_id, and trello_list_ids are required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('channels')
      .update({
        name,
        trello_board_id,
        trello_list_ids,
        auto_run_enabled: auto_run_enabled ?? true,
        voice_config: voice_config ?? undefined,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
