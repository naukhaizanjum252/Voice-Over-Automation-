import { supabase } from '@/lib/supabase';
import type { Channel, StoredFile, PrimaryDocument, ProcessingResult, TitleListMapping } from '@/types';
import * as trelloService from './trelloService';
import { generateScript, type ScriptGenConfig } from './scriptService';
import { generateAudio } from './voiceService';
import { extractText } from './fileParserService';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const FEEDER_SCRIPTS_BUCKET = 'feeder-scripts';
const PRIMARY_DOCS_BUCKET = 'primary-documents';
const CONCURRENCY_LIMIT = 5;

/**
 * Script Generation Pipeline
 *
 * Flow:
 *   Title List (source) → detect new cards → take card name as title
 *   → generate script via Claude (primary docs + feeder scripts + template fields + title)
 *   → upload .docx to card → move card to Voiceover Source List (target)
 *
 * The voiceover cron then picks up cards from the target list separately.
 */

/**
 * Processes all channels that have script generation enabled.
 * A channel qualifies when it has at least one title_list_mapping.
 */
export async function processAllScripts(): Promise<ProcessingResult[]> {
  console.log('[script-cron] Fetching channels with script generation...');
  const { data: channels, error } = await supabase
    .from('channels')
    .select('*')
    .eq('auto_run_enabled', true);

  if (error) throw new Error(`Failed to fetch channels: ${error.message}`);
  if (!channels || channels.length === 0) {
    console.log('[script-cron] No channels found.');
    return [];
  }

  // Filter to channels that have at least one title list mapping
  const scriptChannels = (channels as Channel[]).filter(
    (ch) => ch.title_list_mappings && ch.title_list_mappings.length > 0
  );

  if (scriptChannels.length === 0) {
    console.log('[script-cron] No channels with script generation configured.');
    return [];
  }

  // Pre-fetch primary documents ONCE (global, shared across all channels)
  const primaryDocTexts = await fetchPrimaryDocTexts();
  console.log(`[script-cron] Loaded ${primaryDocTexts.length} primary instruction documents`);

  if (primaryDocTexts.length === 0) {
    console.warn('[script-cron] No primary documents found — scripts may lack instructions');
  }

  // Fetch the configured model
  const scriptModel = await fetchScriptModel();
  console.log(`[script-cron] Using model: ${scriptModel}`);

  const results: ProcessingResult[] = [];
  for (const ch of scriptChannels) {
    const channelResults = await processChannelScripts(ch, primaryDocTexts, scriptModel);
    results.push(...channelResults);
  }
  return results;
}

/**
 * Processes script generation for a single channel.
 * Iterates through all title_list_mappings — for each mapping, fetches cards
 * from the title list and generates scripts, moving completed cards to the
 * mapped voiceover list.
 */
export async function processChannelScripts(
  channel: Channel,
  primaryDocTexts: string[],
  model?: string
): Promise<ProcessingResult[]> {
  if (!channel.title_list_mappings || channel.title_list_mappings.length === 0) {
    return [];
  }

  const results: ProcessingResult[] = [];

  // Pre-fetch feeder script texts once per channel run
  let feederTexts: string[] | undefined;
  if (channel.feeder_scripts && channel.feeder_scripts.length > 0) {
    feederTexts = await fetchStoredFileTexts(channel.feeder_scripts, FEEDER_SCRIPTS_BUCKET);
    console.log(`[script] Loaded ${feederTexts.length} feeder scripts for channel "${channel.name}"`);
  }

  // Collect all eligible cards across all mappings first
  const eligibleCards: { cardId: string; cardName: string; targetListId: string }[] = [];

  for (const mapping of channel.title_list_mappings) {
    let cards;
    try {
      cards = await trelloService.getCardsInList(mapping.titleListId);
    } catch (err) {
      console.error(`[script] Failed to fetch title list ${mapping.titleListId}:`, err);
      continue;
    }

    if (cards.length === 0) {
      console.log(`[script] No cards in title list ${mapping.titleListId} for channel "${channel.name}"`);
      continue;
    }

    for (const card of cards) {
      // Skip cards that already have a script attachment
      const existingScript = trelloService.getScriptAttachment(card.attachments || []);
      if (existingScript) {
        console.log(`[script] Card "${card.name}" already has a script, skipping`);
        continue;
      }

      // Skip cards already being processed or completed
      const { data: existing } = await supabase
        .from('processed_cards')
        .select('id, status')
        .eq('trello_card_id', card.id)
        .single();

      if (existing && (existing.status === 'processing' || existing.status === 'completed' || existing.status === 'pending' || existing.status === 'failed')) {
        console.log(`[script] Card "${card.name}" already ${existing.status}, skipping`);
        continue;
      }

      eligibleCards.push({ cardId: card.id, cardName: card.name, targetListId: mapping.voiceoverListId });
    }
  }

  if (eligibleCards.length === 0) return results;

  console.log(`[script] Processing ${eligibleCards.length} cards in parallel (concurrency: ${CONCURRENCY_LIMIT}) for channel "${channel.name}"`);

  // Process eligible cards in parallel with concurrency limit
  const tasks = eligibleCards.map((card) => async () => {
    try {
      return await processScriptCard(card.cardId, card.cardName, channel, primaryDocTexts, feederTexts, card.targetListId, model);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[script] Card ${card.cardId} error:`, errMsg);
      return { cardId: card.cardId, cardName: card.cardName, success: false, error: errMsg } as ProcessingResult;
    }
  });

  const parallelResults = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);
  results.push(...parallelResults);

  return results;
}

/**
 * Generates a script for a single card:
 * 1. Build config from primary docs + feeder scripts + channel template fields
 * 2. Generate script using Claude
 * 3. Create .docx file from the script text
 * 4. Upload .docx to the card
 * 5. Move card to the target voiceover list
 */
async function processScriptCard(
  cardId: string,
  cardName: string,
  channel: Channel,
  primaryDocTexts: string[],
  feederTexts?: string[],
  targetListId?: string,
  model?: string
): Promise<ProcessingResult> {
  // Stage 1: Generate script
  await upsertCard(cardId, cardName, channel.id, 'processing', null, null, 'script_generating');

  try {
    const config: ScriptGenConfig = {
      primaryDocTexts,
      feederScriptTexts: feederTexts,
      niche: channel.niche,
      format: channel.format,
      length: channel.length,
      characterCount: channel.character_count,
      output: channel.output,
      note: channel.note,
    };

    console.log(`[script] Generating script for "${cardName}"...`);
    const scriptText = await generateScript(config, cardName, model);
    console.log(`[script] Script generated: ${scriptText.length} chars`);

    // Stage 2: Upload script to Trello
    await updateStage(cardId, 'script_uploading');
    const docxBuffer = await buildDocx(cardName, scriptText);
    const sanitizedName = cardName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const scriptFileName = `${sanitizedName}_script.docx`;
    const scriptUploaded = await trelloService.uploadAttachmentToCard(
      cardId,
      scriptFileName,
      docxBuffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    console.log(`[script] Script uploaded to card "${cardName}": ${scriptFileName}`);

    // Move card to target voiceover list
    if (targetListId) {
      await trelloService.moveCardToList(cardId, targetListId);
      console.log(`[script] Card "${cardName}" moved to voiceover list ${targetListId}`);
    }

    // Save script URL
    await upsertCard(cardId, cardName, channel.id, 'processing', null, null, 'generating', scriptUploaded.url);

    // Stage 3: Generate voiceover from the script text we already have
    console.log(`[script] Generating voiceover for "${cardName}" (${scriptText.length} chars)...`);
    const audioBuffer = await generateAudio(scriptText, channel.voice_config, async (stage) => {
      await updateStage(cardId, stage === 'generating' ? 'generating' : 'generating');
    });
    console.log(`[script] Voiceover ready: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Stage 4: Upload voiceover to Trello
    await updateStage(cardId, 'uploading');
    const voiceFileName = `${sanitizedName}_voiceover.mp3`;
    const voiceUploaded = await trelloService.uploadAttachmentToCard(
      cardId,
      voiceFileName,
      audioBuffer
    );
    console.log(`[script] Voiceover uploaded to card "${cardName}": ${voiceFileName}`);

    // Done
    await upsertCard(cardId, cardName, channel.id, 'completed', null, voiceUploaded.url, null, scriptUploaded.url);

    return { cardId, cardName, success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await upsertCard(cardId, cardName, channel.id, 'failed', errMsg, null, null);
    return { cardId, cardName, success: false, error: errMsg };
  }
}

/**
 * Fetches all primary instruction documents from the DB + Storage.
 * These are global — shared across all channels.
 */
export async function fetchPrimaryDocTexts(): Promise<string[]> {
  const { data: docs, error } = await supabase
    .from('primary_documents')
    .select('*')
    .order('uploaded_at', { ascending: true });

  if (error || !docs || docs.length === 0) {
    if (error) console.error('[script] Failed to fetch primary documents:', error.message);
    return [];
  }

  const texts: string[] = [];
  for (const doc of docs as PrimaryDocument[]) {
    try {
      const { data, error: dlError } = await supabase.storage
        .from(PRIMARY_DOCS_BUCKET)
        .download(doc.storage_path);

      if (dlError || !data) {
        console.error(`[script] Failed to download primary doc "${doc.name}":`, dlError?.message);
        continue;
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const text = await extractText(buffer, doc.name);

      if (text && text.trim().length > 0) {
        texts.push(text.trim());
      } else {
        console.warn(`[script] Primary doc "${doc.name}" extracted empty text, skipping`);
      }
    } catch (err) {
      console.error(`[script] Error processing primary doc "${doc.name}":`, err);
    }
  }

  return texts;
}

/**
 * Fetches the configured script generation model from app_settings.
 */
async function fetchScriptModel(): Promise<string | undefined> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'script_model')
      .single();

    if (error || !data) return undefined;
    return data.value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Downloads and extracts text from stored files (feeder scripts or any StoredFile[]).
 */
async function fetchStoredFileTexts(files: StoredFile[], bucket: string): Promise<string[]> {
  const texts: string[] = [];

  for (const file of files) {
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(file.storage_path);

      if (error || !data) {
        console.error(`[script] Failed to download "${file.name}":`, error?.message);
        continue;
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const text = await extractText(buffer, file.name);

      if (text && text.trim().length > 0) {
        texts.push(text.trim());
      } else {
        console.warn(`[script] File "${file.name}" extracted empty text, skipping`);
      }
    } catch (err) {
      console.error(`[script] Error processing file "${file.name}":`, err);
    }
  }

  return texts;
}

/**
 * Builds a .docx Buffer from script text.
 */
async function buildDocx(_title: string, scriptText: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];

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

// ── Concurrency ──

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
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

async function updateStage(trelloCardId: string, stage: string) {
  const { error } = await supabase
    .from('processed_cards')
    .update({ processing_stage: stage, updated_at: new Date().toISOString() })
    .eq('trello_card_id', trelloCardId);

  if (error) {
    console.error(`[script] Failed to update stage for ${trelloCardId}:`, error.message);
  }
}
