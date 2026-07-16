CREATE TABLE package_versions (
  id uuid PRIMARY KEY,
  package_id text NOT NULL,
  version text NOT NULL,
  format_tag text NOT NULL CHECK (length(btrim(format_tag)) > 0),
  canonical_sha256 text,
  cas_index_id text,
  state text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_versions_package_version_unique UNIQUE (package_id, version),
  CONSTRAINT package_versions_state_check CHECK (
    state IN ('CREATED', 'UPLOADING', 'ASSEMBLED', 'PROMOTING', 'READY', 'FAILED')
  ),
  CONSTRAINT package_versions_catalog_pair_check CHECK (
    (canonical_sha256 IS NULL) = (cas_index_id IS NULL)
  ),
  CONSTRAINT package_versions_assembled_fields_check CHECK (
    state NOT IN ('ASSEMBLED', 'PROMOTING', 'READY')
    OR (canonical_sha256 IS NOT NULL AND cas_index_id IS NOT NULL)
  ),
  CONSTRAINT package_versions_sha256_check CHECK (
    canonical_sha256 IS NULL OR canonical_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT package_versions_cas_index_id_check CHECK (
    cas_index_id IS NULL OR length(btrim(cas_index_id)) > 0
  ),
  CONSTRAINT package_versions_error_check CHECK (
    (state = 'FAILED' AND error IS NOT NULL AND length(btrim(error)) > 0)
    OR (state <> 'FAILED' AND error IS NULL)
  )
);

CREATE TABLE catalog_outbox (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL REFERENCES package_versions(id),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);

CREATE INDEX catalog_outbox_unpublished_idx
  ON catalog_outbox (created_at, id)
  WHERE published_at IS NULL;
