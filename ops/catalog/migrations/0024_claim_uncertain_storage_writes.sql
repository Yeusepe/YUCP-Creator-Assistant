ALTER TABLE storage_write_intents
  ADD COLUMN retry_claim_token uuid,
  ADD COLUMN retry_claim_expires_at timestamptz,
  DROP CONSTRAINT storage_write_intents_state_check,
  ADD CONSTRAINT storage_write_intents_state_check CHECK (
    state IN ('ABORTED', 'COMMITTED', 'ISSUED', 'RETRYING', 'UNCERTAIN')
  ),
  ADD CONSTRAINT storage_write_intents_retry_claim_check CHECK (
    (
      state = 'RETRYING'
      AND retry_claim_token IS NOT NULL
      AND retry_claim_expires_at IS NOT NULL
    )
    OR (
      state <> 'RETRYING'
      AND retry_claim_token IS NULL
      AND retry_claim_expires_at IS NULL
    )
  );

DROP INDEX storage_write_intents_reconcile_idx;

CREATE INDEX storage_write_intents_reconcile_idx
  ON storage_write_intents (state, updated_at, id)
  WHERE state IN ('ISSUED', 'RETRYING', 'UNCERTAIN');
