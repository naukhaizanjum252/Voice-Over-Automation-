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
    const debug: string[] = [];

    debug.push(`Channel: "${ch.name}" (${ch.id})`);
    debug.push(`Voiceover lists: [${ch.trello_list_ids.join(', ')}]`);
    debug.push(`Title mappings: ${ch.title_list_mappings?.length ?? 0}`);
    debug.push(`Auto-run: ${ch.auto_run_enabled}`);

    // Phase 1: Generate scripts (if title list mappings configured)
    let scriptResults: { cardId: string; cardName: string; success: boolean; error?: string }[] = [];
    if (ch.title_list_mappings && ch.title_list_mappings.length > 0) {
      debug.push('Phase 1: Script generation starting...');
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
      debug.push(`Phase 1 done: ${scriptResults.length} cards processed`);
    } else {
      debug.push('Phase 1: Skipped (no title list mappings)');
    }

    // Phase 2: Generate voiceovers
    debug.push(`Phase 2: Voiceover processing starting for ${ch.trello_list_ids.length} lists...`);

    // Fetch cards from each list and log what we find
    const { getCardsInList, getScriptAttachment, hasAudioAttachment } = await import('@/services/trelloService');
    for (const listId of ch.trello_list_ids) {
      try {
        const listCards = await getCardsInList(listId);
        debug.push(`  List ${listId}: ${listCards.length} cards found`);
        for (const c of listCards) {
          const attachInfo = (c.attachments || []).map((a: { name: string; mimeType?: string }) => `${a.name} (${a.mimeType || 'no-mime'})`);
          const hasScript = !!getScriptAttachment(c.attachments || []);
          const hasAudio = hasAudioAttachment(c.attachments || []);
          debug.push(`    → "${c.name}" | attachments: [${attachInfo.join(', ')}] | script: ${hasScript} | audio: ${hasAudio}`);
        }
      } catch (err) {
        debug.push(`  List ${listId}: FETCH ERROR — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const voiceResults = await processChannel(ch);
    debug.push(`Phase 2 done: ${voiceResults.length} cards processed`);

    return NextResponse.json({
      scripts: scriptResults,
      voiceovers: voiceResults,
      debug,
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
