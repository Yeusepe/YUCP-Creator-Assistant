CREATE TABLE package_versions (
  id uuid PRIMARY KEY,
  package_id text NOT NULL CHECK (btrim(package_id) <> '' AND length(package_id) <= 256),
  version text NOT NULL CHECK (btrim(version) <> '' AND length(version) <= 256),
  source_format text CHECK (length(btrim(source_format)) > 0),
  release_root text,
  assembly_object_id text,
  state text NOT NULL,
  error text,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_versions_package_version_unique UNIQUE (package_id, version),
  CONSTRAINT package_versions_state_check CHECK (
    state IN ('CREATED', 'UPLOADING', 'ASSEMBLED', 'PROMOTING', 'READY', 'FAILED')
  ),
  CONSTRAINT package_versions_catalog_pair_check CHECK (
    (release_root IS NULL) = (assembly_object_id IS NULL)
  ),
  CONSTRAINT package_versions_assembled_fields_check CHECK (
    state NOT IN ('ASSEMBLED', 'PROMOTING', 'READY')
    OR (source_format IS NOT NULL AND release_root IS NOT NULL AND assembly_object_id IS NOT NULL)
  ),
  CONSTRAINT package_versions_sha256_check CHECK (
    release_root IS NULL OR release_root ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT package_versions_assembly_object_id_check CHECK (
    assembly_object_id IS NULL OR length(btrim(assembly_object_id)) > 0
  ),
  CONSTRAINT package_versions_error_check CHECK (
    (state = 'FAILED' AND error IS NOT NULL AND length(btrim(error)) > 0)
    OR (state <> 'FAILED' AND error IS NULL)
  )
);

CREATE INDEX package_versions_reconcile_eligible_idx
  ON package_versions (attempts, next_attempt_at, updated_at, id)
  WHERE state IN ('UPLOADING', 'ASSEMBLED', 'PROMOTING', 'FAILED');

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
