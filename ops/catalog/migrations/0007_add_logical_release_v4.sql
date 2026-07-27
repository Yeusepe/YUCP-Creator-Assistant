ALTER TABLE package_versions
  ADD COLUMN common_root text,
  ADD COLUMN protected_source_root text,
  ADD COLUMN binding_root text,
  ADD COLUMN manifest_sha256 text,
  ADD COLUMN active_content_digest text,
  ADD COLUMN active_policy_version text,
  ADD COLUMN protection_policy_id text,
  ADD COLUMN protection_policy_digest text,
  ADD COLUMN logical_bytes bigint,
  ADD COLUMN logical_files int,
  ADD COLUMN protected_files jsonb,
  ADD COLUMN release_schema_version smallint;

UPDATE package_versions
SET
  release_schema_version = CASE
    WHEN state = 'READY' THEN 3
    ELSE 4
  END;

ALTER TABLE package_versions
  ALTER COLUMN release_schema_version SET DEFAULT 4,
  ALTER COLUMN release_schema_version SET NOT NULL,
  ADD CONSTRAINT package_versions_release_schema_version_check CHECK (
    release_schema_version IN (3, 4)
  ),
  ADD CONSTRAINT package_versions_v4_sha256_check CHECK (
    (common_root IS NULL OR common_root ~ '^[0-9a-f]{64}$')
    AND (protected_source_root IS NULL OR protected_source_root ~ '^[0-9a-f]{64}$')
    AND (binding_root IS NULL OR binding_root ~ '^[0-9a-f]{64}$')
    AND (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$')
    AND (active_content_digest IS NULL OR active_content_digest ~ '^[0-9a-f]{64}$')
    AND (protection_policy_digest IS NULL OR protection_policy_digest ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT package_versions_v4_counts_check CHECK (
    (logical_bytes IS NULL OR logical_bytes BETWEEN 0 AND 68719476736)
    AND (logical_files IS NULL OR logical_files BETWEEN 1 AND 100000)
  ),
  ADD CONSTRAINT package_versions_v4_protected_files_check CHECK (
    protected_files IS NULL
    OR (
      jsonb_typeof(protected_files) = 'array'
      AND jsonb_array_length(protected_files) <= 512
    )
  ),
  ADD CONSTRAINT package_versions_v4_ready_fields_check CHECK (
    state <> 'READY'
    OR (
      release_schema_version = 3
      AND format_tag IS NOT NULL
      AND canonical_sha256 IS NOT NULL
      AND cas_index_id IS NOT NULL
    )
    OR (
      release_schema_version = 4
      AND common_root IS NOT NULL
      AND protected_source_root IS NOT NULL
      AND binding_root IS NOT NULL
      AND manifest_sha256 IS NOT NULL
      AND active_content_digest IS NOT NULL
      AND active_policy_version IS NOT NULL
      AND length(btrim(active_policy_version)) > 0
      AND protection_policy_id IS NOT NULL
      AND length(btrim(protection_policy_id)) > 0
      AND protection_policy_digest IS NOT NULL
      AND logical_bytes IS NOT NULL
      AND logical_files IS NOT NULL
      AND protected_files IS NOT NULL
    )
  );

CREATE INDEX package_versions_legacy_ready_migration_idx
  ON package_versions (updated_at, id)
  WHERE state = 'READY' AND release_schema_version = 3;
