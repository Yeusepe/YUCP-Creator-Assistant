-- Renditions are served directly from the materializer; the broker no longer
-- brokers B2 uploads, so the write-intent flow and its receipt bindings go away.
ALTER TABLE materialization_receipts
  DROP COLUMN rendition_write_intent_id,
  DROP COLUMN provider_version;

DROP TABLE materialization_rendition_write_intents;
