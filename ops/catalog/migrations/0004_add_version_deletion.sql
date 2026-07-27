ALTER TABLE package_versions
  DROP CONSTRAINT package_versions_state_check,
  DROP CONSTRAINT package_versions_error_check,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deletion_reason text,
  ADD CONSTRAINT package_versions_state_check CHECK (
    state IN ('CREATED', 'UPLOADING', 'ASSEMBLED', 'PROMOTING', 'READY', 'FAILED', 'DELETED')
  ),
  ADD CONSTRAINT package_versions_deletion_fields_check CHECK (
    (
      state = 'DELETED'
      AND deleted_at IS NOT NULL
      AND deletion_reason IS NOT NULL
      AND length(btrim(deletion_reason)) > 0
    )
    OR (
      state <> 'DELETED'
      AND deleted_at IS NULL
      AND deletion_reason IS NULL
    )
  ),
  ADD CONSTRAINT package_versions_error_check CHECK (
    (state = 'FAILED' AND error IS NOT NULL AND length(btrim(error)) > 0)
    OR (state NOT IN ('FAILED', 'DELETED') AND error IS NULL)
    OR state = 'DELETED'
  );
