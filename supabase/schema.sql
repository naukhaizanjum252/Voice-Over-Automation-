-- ============================================
-- Voiceover Tool — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Channels table ──
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  trello_board_id TEXT NOT NULL,
  trello_list_ids TEXT[] NOT NULL DEFAULT '{}',
  trello_title_list_id TEXT DEFAULT NULL,
  master_prompt TEXT DEFAULT NULL,
  auto_run_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  voice_config JSONB NOT NULL DEFAULT '{
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "speed": 1.0,
    "pitch": 1.0,
    "stability": 0.5,
    "style": 0.0
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Processed Cards table ──
CREATE TABLE IF NOT EXISTS processed_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trello_card_id TEXT NOT NULL UNIQUE,
  card_name TEXT DEFAULT '',
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  processing_stage TEXT DEFAULT NULL
    CHECK (processing_stage IS NULL OR processing_stage IN ('script_generating', 'downloading', 'extracting', 'generating', 'queued', 'uploading')),
  error_message TEXT,
  script_url TEXT,
  attachment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_processed_cards_channel
  ON processed_cards(channel_id);

CREATE INDEX IF NOT EXISTS idx_processed_cards_status
  ON processed_cards(status);

CREATE INDEX IF NOT EXISTS idx_processed_cards_trello_id
  ON processed_cards(trello_card_id);

-- ── Row Level Security (disabled for internal tool) ──
-- If you want to add RLS later, uncomment below:
-- ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE processed_cards ENABLE ROW LEVEL SECURITY;
