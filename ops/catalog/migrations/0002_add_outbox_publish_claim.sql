ALTER TABLE catalog_outbox
  ADD COLUMN publish_claim_id uuid,
  ADD COLUMN publish_claimed_at timestamptz,
  ADD CONSTRAINT catalog_outbox_publish_claim_pair_check CHECK (
    (publish_claim_id IS NULL) = (publish_claimed_at IS NULL)
  );
