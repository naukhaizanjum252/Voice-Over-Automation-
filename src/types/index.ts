// ── Database Types ──

export interface Channel {
  id: string;
  name: string;
  trello_board_id: string;
  trello_list_ids: string[];
  auto_run_enabled: boolean;
  voice_config: VoiceConfig;
  created_at: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed: number;
  pitch: number;
  stability: number;
}

export interface ProcessedCard {
  id: string;
  trello_card_id: string;
  channel_id: string;
  card_name: string;
  status: CardStatus;
  processing_stage: ProcessingStage | null;
  error_message: string | null;
  attachment_url: string | null;
  created_at: string;
  updated_at: string;
}

export type CardStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ProcessingStage = 'downloading' | 'extracting' | 'generating' | 'queued' | 'uploading';

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

export interface ChannelStats {
  channel: Channel;
  boardName: string;
  listNames: string[];
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
