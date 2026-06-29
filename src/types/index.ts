// ── Database Types ──

/** A file uploaded to Supabase Storage (used for feeder scripts and primary docs) */
export interface StoredFile {
  name: string;        // original filename
  storage_path: string; // path in Supabase Storage bucket
  size: number;         // file size in bytes
  uploaded_at: string;  // ISO timestamp
}

/** @deprecated Use StoredFile instead */
export type CompetitorScript = StoredFile;

/** Global primary instruction documents (shared across all channels) */
export interface PrimaryDocument {
  id: string;
  name: string;
  storage_path: string;
  size: number;
  uploaded_at: string;
}

/** Maps a title source list to its target voiceover list */
export interface TitleListMapping {
  titleListId: string;
  voiceoverListId: string;
}

export interface Channel {
  id: string;
  name: string;
  trello_board_id: string;
  trello_list_ids: string[];
  title_list_mappings: TitleListMapping[];
  auto_run_enabled: boolean;
  voice_config: VoiceConfig;
  // Script generation fields (all optional per channel)
  niche: string | null;
  format: string | null;
  length: string | null;
  character_count: number | null;
  output: string | null;
  note: string | null;
  feeder_scripts: StoredFile[];
  created_at: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed: number;
  pitch: number;
  stability: number;
  style: number;
}

export interface ProcessedCard {
  id: string;
  trello_card_id: string;
  channel_id: string;
  card_name: string;
  status: CardStatus;
  processing_stage: ProcessingStage | null;
  error_message: string | null;
  script_url: string | null;
  attachment_url: string | null;
  retry_count: number;
  tts_job: TtsJob | null;
  created_at: string;
  updated_at: string;
}

export type TtsProvider = 'ai84' | '69labs';

/** An in-flight async TTS job persisted on a card so it survives across cron runs. */
export interface TtsJob {
  provider: TtsProvider;
  jobId: string;
  /** Resolved provider voice id actually used (AI84 canonical id or 69 Labs voiceId). */
  voiceId: string;
  startedAt: string;
  /** Providers already attempted, so cross-invocation fallback doesn't retry the same one. */
  triedProviders: TtsProvider[];
}

/** Result of polling a TTS job once. */
export type TtsPollResult =
  | { state: 'running' }
  | { state: 'done'; audio: Buffer }
  | { state: 'failed'; error: string };

export type CardStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ProcessingStage =
  // Script flow: title → script → upload script → voice → upload voice
  | 'script_generating'    // Generating script via Claude
  | 'script_uploading'     // Uploading script .docx to Trello
  // Voiceover-only flow: detect script → voice → upload voice
  | 'downloading'          // Downloading script from Trello
  | 'extracting'           // Extracting text from script file
  // Shared stages (both flows)
  | 'queued'              // TTS job queued, waiting for processing
  | 'generating'           // Generating voiceover audio
  | 'uploading';           // Uploading voiceover to Trello

// ── Trello Types ──

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  attachments: TrelloAttachment[];
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  bytes: number;
}

// ── API Types ──

/** Resolved name pair for a title list mapping */
export interface TitleListMappingResolved {
  titleListId: string;
  titleListName: string;
  voiceoverListId: string;
  voiceoverListName: string;
}

export interface ChannelStats {
  channel: Channel;
  boardName: string;
  listNames: string[];
  titleListMappings: TitleListMappingResolved[];
  total: number;
  completed: number;
  failed: number;
  processing: number;
  lastRun: string | null;
  cards: ProcessedCard[];
}

export interface ProcessingResult {
  cardId: string;
  cardName: string;
  success: boolean;
  error?: string;
}

// ── Voice Types (69 Labs) ──

export interface Voice {
  voice_id: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
  preview_url?: string;
}
