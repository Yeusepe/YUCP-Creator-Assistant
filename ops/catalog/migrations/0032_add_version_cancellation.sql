ALTER TABLE package_versions
  DROP CONSTRAINT package_versions_state_check,
  DROP CONSTRAINT package_versions_error_check,
  ADD CONSTRAINT package_versions_state_check CHECK (
    state IN (
      'CREATED',
      'UPLOADING',
      'ASSEMBLED',
      'PROMOTING',
      'READY',
      'FAILED',
      'CANCELED',
      'DELETED'
    )
  ),
  ADD CONSTRAINT package_versions_error_check CHECK (
    (state = 'FAILED' AND error IS NOT NULL AND length(btrim(error)) > 0)
    OR (state NOT IN ('FAILED', 'CANCELED', 'DELETED') AND error IS NULL)
    OR state IN ('CANCELED', 'DELETED')
  );
