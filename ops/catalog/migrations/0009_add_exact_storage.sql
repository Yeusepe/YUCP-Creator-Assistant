CREATE TABLE storage_object_versions (
  id uuid PRIMARY KEY,
  storage_role text NOT NULL
    CHECK (storage_role IN ('common', 'metadata', 'protected', 'quarantine', 'renditions')),
  bucket_name text NOT NULL CHECK (btrim(bucket_name) <> '' AND length(bucket_name) <= 255),
  object_key text NOT NULL CHECK (btrim(object_key) <> '' AND length(object_key) <= 2048),
  provider_version text NOT NULL
    CHECK (btrim(provider_version) <> '' AND length(provider_version) <= 512),
  file_identifier text NOT NULL
    CHECK (btrim(file_identifier) <> '' AND length(file_identifier) <= 512),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  bytes bigint NOT NULL CHECK (bytes >= 0 AND bytes <= 68719476736),
  content_type text NOT NULL
    CHECK (btrim(content_type) <> '' AND length(content_type) <= 255),
  verification_state text NOT NULL
    CHECK (verification_state IN ('VERIFIED', 'REJECTED', 'DELETED')),
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT storage_object_versions_state_check CHECK (
    (
      verification_state = 'VERIFIED'
      AND verified_at IS NOT NULL
      AND deleted_at IS NULL
    )
    OR (
      verification_state = 'REJECTED'
      AND verified_at IS NULL
      AND deleted_at IS NULL
    )
    OR (
      verification_state = 'DELETED'
      AND deleted_at IS NOT NULL
    )
  ),
  UNIQUE (storage_role, bucket_name, object_key, provider_version),
  UNIQUE (storage_role, bucket_name, file_identifier)
);

CREATE TABLE storage_write_intents (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE
    CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 512),
  owner_kind text NOT NULL
    CHECK (owner_kind IN ('package-version', 'materialization-job', 'maintenance')),
  owner_id text NOT NULL CHECK (btrim(owner_id) <> '' AND length(owner_id) <= 512),
  lease_generation int NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  operation text NOT NULL CHECK (operation IN ('COPY', 'MULTIPART_PUT', 'PUT')),
  storage_role text NOT NULL
    CHECK (storage_role IN ('common', 'metadata', 'protected', 'quarantine', 'renditions')),
  storage_domain text CHECK (
    storage_domain IS NULL
    OR (btrim(storage_domain) <> '' AND length(storage_domain) <= 512)
  ),
  bucket_name text NOT NULL CHECK (btrim(bucket_name) <> '' AND length(bucket_name) <= 255),
  object_key text NOT NULL CHECK (btrim(object_key) <> '' AND length(object_key) <= 2048),
  expected_sha256 bytea NOT NULL CHECK (octet_length(expected_sha256) = 32),
  expected_bytes bigint NOT NULL CHECK (expected_bytes >= 0 AND expected_bytes <= 68719476736),
  content_type text NOT NULL
    CHECK (btrim(content_type) <> '' AND length(content_type) <= 255),
  state text NOT NULL CHECK (state IN ('ABORTED', 'COMMITTED', 'ISSUED', 'UNCERTAIN')),
  object_version_id uuid REFERENCES storage_object_versions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT storage_write_intents_commit_check CHECK (
    (state = 'COMMITTED' AND object_version_id IS NOT NULL)
    OR (state <> 'COMMITTED' AND object_version_id IS NULL)
  )
);

CREATE INDEX storage_write_intents_reconcile_idx
  ON storage_write_intents (state, updated_at, id)
  WHERE state IN ('ISSUED', 'UNCERTAIN');

CREATE TABLE canonical_storage_objects (
  storage_role text NOT NULL
    CHECK (storage_role IN ('common', 'metadata', 'protected')),
  storage_domain text NOT NULL
    CHECK (btrim(storage_domain) <> '' AND length(storage_domain) <= 512),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  bytes bigint NOT NULL CHECK (bytes >= 0 AND bytes <= 68719476736),
  object_version_id uuid NOT NULL REFERENCES storage_object_versions(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (storage_role, storage_domain, sha256, bytes)
);

CREATE TABLE package_release_storage_objects (
  package_version_id uuid NOT NULL REFERENCES package_versions(id),
  logical_kind text NOT NULL
    CHECK (logical_kind IN ('chunk', 'delivery-binding', 'file-table', 'manifest', 'membership')),
  logical_digest bytea NOT NULL CHECK (octet_length(logical_digest) = 32),
  object_version_id uuid NOT NULL REFERENCES storage_object_versions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (package_version_id, logical_kind, logical_digest, object_version_id)
);

CREATE INDEX package_release_storage_objects_closure_idx
  ON package_release_storage_objects (package_version_id, logical_kind, logical_digest);
