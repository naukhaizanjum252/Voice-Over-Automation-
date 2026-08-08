-- ============================================
-- Migration 0002: status-machine hardening
-- Safe to run on the live table — additive + idempotent.
-- ============================================

-- 1) retry_count — used by recoverStaleJobs to cap auto-retries of cards that stall
--    before a TTS job starts. Already present on the live DB; documented here so a
--    fresh deploy doesn't silently break stale-card recovery.
ALTER TABLE processed_cards
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- 2) Allow the 'script_uploading' processing_stage that the code sets while uploading the
--    generated .docx. The original CHECK omitted it, so that stage update was rejected by
--    the DB (a code↔schema mismatch — the card silently stayed on the previous stage).
--    Widening the CHECK never invalidates existing rows.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'processed_cards'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%processing_stage%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE processed_cards DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE processed_cards
  ADD CONSTRAINT processed_cards_processing_stage_check
  CHECK (processing_stage IS NULL OR processing_stage IN (
    'script_generating', 'script_uploading', 'downloading', 'extracting',
    'queued', 'generating', 'uploading'
  ));
