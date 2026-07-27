CREATE TABLE package_quarantine_objects (
  version_id uuid PRIMARY KEY REFERENCES package_versions(id),
  object_key text NOT NULL
    CHECK (btrim(object_key) <> '' AND length(object_key) <= 1024),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 5368709120),
  content_type text NOT NULL
    CHECK (btrim(content_type) <> '' AND length(content_type) <= 255),
  state text NOT NULL CHECK (state IN ('PENDING', 'UNCERTAIN', 'COMMITTED')),
  provider_version text CHECK (
    provider_version IS NULL
    OR (btrim(provider_version) <> '' AND length(provider_version) <= 512)
  ),
  file_identifier text CHECK (
    file_identifier IS NULL
    OR (btrim(file_identifier) <> '' AND length(file_identifier) <= 512)
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_quarantine_objects_exact_version_check CHECK (
    (
      state = 'COMMITTED'
      AND provider_version IS NOT NULL
      AND file_identifier IS NOT NULL
    )
    OR (
      state <> 'COMMITTED'
      AND provider_version IS NULL
      AND file_identifier IS NULL
    )
  ),
  CONSTRAINT package_quarantine_objects_key_unique UNIQUE (object_key)
);

CREATE INDEX package_quarantine_objects_reconcile_idx
  ON package_quarantine_objects (updated_at, version_id)
  WHERE state IN ('PENDING', 'UNCERTAIN');
