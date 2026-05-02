import { supabase } from '@/lib/supabase';
import type { Channel, ProcessingResult, TrelloCard } from '@/types';
import * as trelloService from './trelloService';
import { extractText } from './fileParserService';
import { generateAudio } from './voiceService';

/**
 * Processes all active channels. Called by cron or manual trigger.
 */
export async function processAllChannels(): Promise<ProcessingResult[]> {
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('auto_run_enabled', true);

  if (error) throw new Error(`Failed to fetch channels: ${error.message}`);
  if (!channels || channels.length === 0) return [];

  const results: ProcessingResult[] = [];
  for (const channel of channels) {
    const channelResults = await processChannel(channel as Channel);
    results.push(...channelResults);
  }
  return results;
}

/**
 * Processes a single channel: fetches cards, extracts scripts, generates audio.
 */
export async function processChannel(
  channel: Channel
): Promise<ProcessingResult[]> {
  const results: ProcessingResult[] = [];

  for (const listId of channel.trello_list_ids) {
    let cards: TrelloCard[];
    try {
      cards = await trelloService.getCardsInList(listId);
    } catch (err) {
      console.error(`[processing] Failed to fetch list ${listId}:`, err);
      continue;
    }

    for (const card of cards) {
      try {
        const result = await processCard(card, channel);
        results.push(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[processing] Card ${card.id} error:`, errMsg);
        results.push({ cardId: card.id, cardName: card.name, success: false, error: errMsg });
      }
    }
  }

  return results;
}

/**
 * Processes a single Trello card.
 */
async function processCard(
  card: TrelloCard,
  channel: Channel
): Promise<ProcessingResult> {
  // Check if already processed
  const { data: existing } = await supabase
    .from('processed_cards')
    .select('id, status')
    .eq('trello_card_id', card.id)
    .single();

  if (existing && existing.status === 'completed') {
    return { cardId: card.id, cardName: card.name, success: true };
  }

  // Find script attachment
  const attachment = trelloService.getScriptAttachment(card.attachments || []);
  if (!attachment) {
    return { cardId: card.id, cardName: card.name, success: true }; // skip silently
  }

  // Upsert as processing — stage: downloading
  await upsertCard(card.id, card.name, channel.id, 'processing', null, null, 'downloading');

  try {
    // 1. Download attachment
    console.log(`[processing] Downloading attachment: ${attachment.name}`);
    const fileBuffer = await trelloService.downloadAttachment(attachment.url);

    // Stage: extracting
    await updateStage(card.id, 'extracting');
    const text = await extractText(fileBuffer, attachment.name);

    if (!text || text.trim().length === 0) {
      throw new Error('Extracted text is empty');
    }

    // Stage: generating
    await updateStage(card.id, 'generating');
    console.log(`[processing] Generating audio for ${text.length} chars`);
    const finalAudio = await generateAudio(text, channel.voice_config);
    console.log(`[processing] Audio ready: ${(finalAudio.length / 1024 / 1024).toFixed(2)} MB`);

    // Stage: uploading
    await updateStage(card.id, 'uploading');
    const sanitizedName = card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `${sanitizedName}_voiceover.mp3`;
    const uploaded = await trelloService.uploadAttachmentToCard(
      card.id,
      fileName,
      finalAudio
    );

    // Done
    await upsertCard(card.id, card.name, channel.id, 'completed', null, uploaded.url, null);

    return { cardId: card.id, cardName: card.name, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await upsertCard(card.id, card.name, channel.id, 'failed', errMsg, null, null);
    return { cardId: card.id, cardName: card.name, success: false, error: errMsg };
  }
}

/**
 * Retries a single failed card by its processed_cards ID.
 */
export async function retryCard(processedCardId: string): Promise<ProcessingResult> {
  const { data: record, error } = await supabase
    .from('processed_cards')
    .select('*, channels(*)')
    .eq('id', processedCardId)
    .single();

  if (error || !record) throw new Error('Card record not found');

  const channel = record.channels as Channel;
  const trelloCardId = record.trello_card_id;

  // Fetch fresh card data from Trello
  const cards = await trelloService.getCardsInList(channel.trello_list_ids[0]);
  const card = cards.find((c) => c.id === trelloCardId);

  if (!card) {
    // Try fetching from all lists
    for (const listId of channel.trello_list_ids) {
      const listCards = await trelloService.getCardsInList(listId);
      const found = listCards.find((c) => c.id === trelloCardId);
      if (found) {
        return processCard(found, channel);
      }
    }
    throw new Error('Card no longer found in Trello');
  }

  return processCard(card, channel);
}

// ── Helpers ──

async function upsertCard(
  trelloCardId: string,
  cardName: string,
  channelId: string,
  status: string,
  errorMessage?: string | null,
  attachmentUrl?: string | null,
  processingStage?: string | null
) {
  const { error } = await supabase.from('processed_cards').upsert(
    {
      trello_card_id: trelloCardId,
      card_name: cardName,
      channel_id: channelId,
      status,
      processing_stage: processingStage ?? null,
      error_message: errorMessage ?? null,
      attachment_url: attachmentUrl ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'trello_card_id' }
  );

  if (error) {
    console.error(`[processing] Failed to upsert card ${trelloCardId}:`, error.message);
  }
}

async function updateStage(trelloCardId: string, stage: string) {
  const { error } = await supabase
    .from('processed_cards')
    .update({
      processing_stage: stage,
      updated_at: new Date().toISOString(),
    })
    .eq('trello_card_id', trelloCardId);

  if (error) {
    console.error(`[processing] Failed to update stage for ${trelloCardId}:`, error.message);
  }
}
