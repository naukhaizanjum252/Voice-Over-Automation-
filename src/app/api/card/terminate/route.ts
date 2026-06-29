import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { cancelCardProcess } from '@/services/processingService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cardId } = body as { cardId?: string };

    if (!cardId) {
      return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
    }

    // Look up the trello_card_id from the processed_cards record
    const { data: record } = await supabase
      .from('processed_cards')
      .select('trello_card_id')
      .eq('id', cardId)
      .eq('status', 'processing')
      .single();

    if (!record) {
      return NextResponse.json({ error: 'Card not found or not currently processing' }, { status: 404 });
    }

    // Cancel the running process (aborts the AbortController)
    const wasCancelled = cancelCardProcess(record.trello_card_id);
    console.log(`[terminate] Card ${cardId} (trello: ${record.trello_card_id}) — process cancelled: ${wasCancelled}`);

    // Mark as failed in DB and clear any in-flight TTS job so the resume step skips it
    const { data, error } = await supabase
      .from('processed_cards')
      .update({
        status: 'failed',
        processing_stage: null,
        error_message: 'Terminated by user',
        tts_job: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', cardId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, cancelled: wasCancelled, card: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
