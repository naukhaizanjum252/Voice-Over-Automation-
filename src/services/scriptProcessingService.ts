import { supabase } from '@/lib/supabase';
import type { Channel, ProcessingResult } from '@/types';
import * as trelloService from './trelloService';
import { generateScript } from './scriptService';
import { Document, Packer, Paragraph, TextRun } from 'docx';

/**
 * Script Generation Pipeline
 *
 * Flow:
 *   Title List (source) → detect new cards → take card name as title
 *   → generate script via Claude (master prompt + title)
 *   → upload .docx to card → move card to Voiceover Source List (target)
 *
 * The voiceover cron then picks up cards from the target list separately.
 */

/**
 * Processes all channels that have script generation enabled.
 * A channel qualifies when it has both trello_title_list_id AND master_prompt set.
 */
export async function processAllScripts(): Promise<ProcessingResult[]> {
  console.log('[script-cron] Fetching channels with script generation...');
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('auto_run_enabled', true)
    .not('trello_title_list_id', 'is', null)
    .not('master_prompt', 'is', null);

  if (error) throw new Error(`Failed to fetch channels: ${error.message}`);
  if (!channels || channels.length === 0) {
    console.log('[script-cron] No channels with script generation configured.');
    return [];
  }

  const results: ProcessingResult[] = [];
  for (const channel of channels) {
    const ch = channel as Channel;
    if (!ch.trello_title_list_id || !ch.master_prompt) continue;
    const channelResults = await processChannelScripts(ch);
    results.push(...channelResults);
  }
  return results;
}

/**
 * Processes script generation for a single channel.
 * Watches the title list — any card without a script attachment gets processed.
 */
export async function processChannelScripts(
  channel: Channel
): Promise<ProcessingResult[]> {
  if (!channel.trello_title_list_id || !channel.master_prompt) {
    return [];
  }

  const results: ProcessingResult[] = [];

  let cards;
  try {
    cards = await trelloService.getCardsInList(channel.trello_title_list_id);
  } catch (err) {
    console.error(`[script] Failed to fetch title list ${channel.trello_title_list_id}:`, err);
    return [];
  }

  if (cards.length === 0) {
    console.log(`[script] No cards in title list for channel "${channel.name}"`);
    return [];
  }

  for (const card of cards) {
    // Skip cards that already have a script attachment
    const existingScript = trelloService.getScriptAttachment(card.attachments || []);
    if (existingScript) {
      console.log(`[script] Card "${card.name}" already has a script, skipping`);
      continue;
    }

    // Skip cards already being processed or completed (prevents duplicate Claude calls)
    const { data: existing } = await supabase
      .from('processed_cards')
      .select('id, status')
      .eq('trello_card_id', card.id)
      .single();

    if (existing && (existing.status === 'processing' || existing.status === 'completed' || existing.status === 'pending' || existing.status === 'failed')) {
      console.log(`[script] Card "${card.name}" already ${existing.status}, skipping`);
      continue;
    }

    try {
      const result = await processScriptCard(card.id, card.name, channel);
      results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[script] Card ${card.id} error:`, errMsg);
      results.push({ cardId: card.id, cardName: card.name, success: false, error: errMsg });
    }
  }

  return results;
}

/**
 * Generates a script for a single card:
 * 1. Take card name as the title
 * 2. Generate script using master prompt + title (Claude)
 * 3. Create .docx file from the script text
 * 4. Upload .docx to the card
 * 5. Move card to the voiceover source list (first list in trello_list_ids)
 */
async function processScriptCard(
  cardId: string,
  cardName: string,
  channel: Channel
): Promise<ProcessingResult> {
  await upsertCard(cardId, cardName, channel.id, 'processing', null, null, 'script_generating');

  try {
    // 1. Generate script text
    console.log(`[script] Generating script for "${cardName}"...`);
    const scriptText = await generateScript(channel.master_prompt!, cardName);
    console.log(`[script] Script generated: ${scriptText.length} chars`);

    // 2. Build .docx
    const docxBuffer = await buildDocx(cardName, scriptText);

    // 3. Upload .docx to the card
    const sanitizedName = cardName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_script.docx`;
    const uploaded = await trelloService.uploadAttachmentToCard(
      cardId,
      fileName,
      docxBuffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    console.log(`[script] Script uploaded to card "${cardName}": ${fileName}`);

    // 4. Move card to voiceover source list (target)
    if (channel.trello_list_ids.length > 0) {
      const targetList = channel.trello_list_ids[0];
      await trelloService.moveCardToList(cardId, targetList);
      console.log(`[script] Card "${cardName}" moved to voiceover source list`);
    }

    // 5. Mark as pending — save script URL for UI
    await upsertCard(cardId, cardName, channel.id, 'pending', null, null, null, uploaded.url);

    return { cardId, cardName, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await upsertCard(cardId, cardName, channel.id, 'failed', errMsg, null, null);
    return { cardId, cardName, success: false, error: errMsg };
  }
}

/**
 * Builds a .docx Buffer from script text.
 * Title as heading, then each paragraph of the script as body text.
 */
async function buildDocx(title: string, scriptText: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({ text: title, bold: true, size: 32, font: 'Arial' }),
      ],
      spacing: { after: 300 },
    }),
  ];

  // Split script into paragraphs and add each
  const lines = scriptText.split(/\n\n+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: trimmed, size: 24, font: 'Arial' }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  const doc = new Document({
    sections: [{ children: paragraphs }],
  });

  const uint8 = await Packer.toBuffer(doc);
  return Buffer.from(uint8);
}

// ── Helpers ──

async function upsertCard(
  trelloCardId: string,
  cardName: string,
  channelId: string,
  status: string,
  errorMessage?: string | null,
  attachmentUrl?: string | null,
  processingStage?: string | null,
  scriptUrl?: string | null
) {
  const record: Record<string, unknown> = {
    trello_card_id: trelloCardId,
    card_name: cardName,
    channel_id: channelId,
    status,
    processing_stage: processingStage ?? null,
    error_message: errorMessage ?? null,
    attachment_url: attachmentUrl ?? null,
    updated_at: new Date().toISOString(),
  };
  // Only set script_url if explicitly provided (avoid overwriting on later calls)
  if (scriptUrl !== undefined) {
    record.script_url = scriptUrl ?? null;
  }
  const { error } = await supabase.from('processed_cards').upsert(
    record,
    { onConflict: 'trello_card_id' }
  );

  if (error) {
    console.error(`[script] Failed to upsert card ${trelloCardId}:`, error.message);
  }
}
