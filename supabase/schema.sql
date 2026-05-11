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
  title_list_mappings JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_run_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Script generation template fields (all optional)
  niche TEXT DEFAULT NULL,
  format TEXT DEFAULT NULL,
  length TEXT DEFAULT NULL,
  character_count INTEGER DEFAULT NULL,
  output TEXT DEFAULT NULL,
  note TEXT DEFAULT NULL,
  feeder_scripts JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Voice config
  voice_config JSONB NOT NULL DEFAULT '{
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "speed": 1.0,
    "pitch": 1.0,
    "stability": 0.5,
    "style": 0.0
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Primary Documents table (global, shared across all channels) ──
CREATE TABLE IF NOT EXISTS primary_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- ── App Settings table (key-value store for global config) ──
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default model
INSERT INTO app_settings (key, value)
VALUES ('script_model', 'claude-haiku-4-5-20251001')
ON CONFLICT (key) DO NOTHING;

-- ── Cron Locks table (for distributed lock) ──
CREATE TABLE IF NOT EXISTS cron_locks (
  lock_name TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Storage buckets ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('primary-documents', 'primary-documents', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('feeder-scripts', 'feeder-scripts', false)
ON CONFLICT (id) DO NOTHING;

-- ── Row Level Security (disabled for internal tool) ──
-- ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE processed_cards ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE primary_documents ENABLE ROW LEVEL SECURITY;
