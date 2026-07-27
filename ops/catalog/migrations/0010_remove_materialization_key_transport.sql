ALTER TABLE materialization_capabilities
  DROP CONSTRAINT materialization_capabilities_consumption_check;

ALTER TABLE materialization_capabilities
  DROP COLUMN recipient_public_key_sha256;

ALTER TABLE materialization_capabilities
  ADD CONSTRAINT materialization_capabilities_consumption_check CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND consumed_by IS NOT NULL
      AND btrim(consumed_by) <> ''
    )
  );
