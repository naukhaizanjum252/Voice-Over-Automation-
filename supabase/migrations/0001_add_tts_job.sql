-- ============================================
-- Migration: resumable async TTS jobs
-- Adds a column to track an in-flight TTS job per card so it can be
-- resumed across cron invocations (instead of re-submitting and burning credits).
-- Additive + nullable — safe to run on the live table; existing rows get NULL.
-- ============================================

ALTER TABLE processed_cards
  ADD COLUMN IF NOT EXISTS tts_job JSONB DEFAULT NULL;

-- Speeds up the "resume in-flight jobs" query (cards with a pending tts_job).
CREATE INDEX IF NOT EXISTS idx_processed_cards_tts_job
  ON processed_cards ((tts_job IS NOT NULL))
  WHERE tts_job IS NOT NULL;
