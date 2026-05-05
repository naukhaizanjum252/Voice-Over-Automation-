import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cardId } = body as { cardId?: string };

    if (!cardId) {
      return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('processed_cards')
      .update({
        status: 'failed',
        processing_stage: null,
        error_message: 'Terminated by user',
        updated_at: new Date().toISOString(),
      })
      .eq('id', cardId)
      .eq('status', 'processing')
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Card not found or not currently processing' }, { status: 404 });
    }

    return NextResponse.json({ success: true, card: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
