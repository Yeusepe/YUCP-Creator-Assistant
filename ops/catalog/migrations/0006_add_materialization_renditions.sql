ALTER TABLE materialization_jobs
  ADD COLUMN encrypted_subject_mapping bytea;

ALTER TABLE materialization_jobs
  ADD CONSTRAINT materialization_jobs_subject_mapping_check
  CHECK (
    encrypted_subject_mapping IS NULL
    OR octet_length(encrypted_subject_mapping) BETWEEN 1 AND 16384
  );

CREATE TABLE materialization_rendition_write_intents (
  id uuid PRIMARY KEY,
  job_id text NOT NULL REFERENCES materialization_jobs(id),
  capability_id text NOT NULL REFERENCES materialization_capabilities(capability_id),
  lease_generation int NOT NULL CHECK (lease_generation > 0),
  bucket_name text NOT NULL CHECK (btrim(bucket_name) <> '' AND length(bucket_name) <= 255),
  object_key text NOT NULL CHECK (btrim(object_key) <> '' AND length(object_key) <= 2048),
  expected_sha256 bytea NOT NULL CHECK (octet_length(expected_sha256) = 32),
  expected_bytes bigint NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 5368709120),
  state text NOT NULL DEFAULT 'ISSUED'
    CHECK (state IN ('ISSUED', 'COMPLETED', 'EXPIRED', 'ABORTED', 'UNCERTAIN')),
  provider_version text,
  file_identifier text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_rendition_write_intents_time_check
    CHECK (expires_at > issued_at),
  CONSTRAINT materialization_rendition_write_intents_version_check CHECK (
    (
      state = 'COMPLETED'
      AND provider_version IS NOT NULL
      AND btrim(provider_version) <> ''
      AND file_identifier IS NOT NULL
      AND btrim(file_identifier) <> ''
      AND completed_at IS NOT NULL
    )
    OR (
      state <> 'COMPLETED'
      AND provider_version IS NULL
      AND file_identifier IS NULL
      AND completed_at IS NULL
    )
  ),
  CONSTRAINT materialization_rendition_write_intents_job_fence_unique
    UNIQUE (job_id, lease_generation),
  CONSTRAINT materialization_rendition_write_intents_object_unique
    UNIQUE (bucket_name, object_key)
);

CREATE INDEX materialization_rendition_write_intents_expiry_idx
  ON materialization_rendition_write_intents (expires_at, id)
  WHERE state IN ('ISSUED', 'UNCERTAIN');

CREATE TABLE materialization_receipts (
  receipt_id text PRIMARY KEY CHECK (btrim(receipt_id) <> '' AND length(receipt_id) <= 128),
  job_id text NOT NULL UNIQUE REFERENCES materialization_jobs(id),
  capability_id text NOT NULL REFERENCES materialization_capabilities(capability_id),
  rendition_write_intent_id uuid NOT NULL UNIQUE
    REFERENCES materialization_rendition_write_intents(id),
  lease_generation int NOT NULL CHECK (lease_generation > 0),
  output_tree_root bytea NOT NULL CHECK (octet_length(output_tree_root) = 32),
  object_sha256 bytea NOT NULL CHECK (octet_length(object_sha256) = 32),
  object_bytes bigint NOT NULL CHECK (object_bytes > 0 AND object_bytes <= 5368709120),
  provider_version text NOT NULL
    CHECK (btrim(provider_version) <> '' AND length(provider_version) <= 512),
  file_identifier text NOT NULL
    CHECK (btrim(file_identifier) <> '' AND length(file_identifier) <= 512),
  signed_receipt bytea NOT NULL CHECK (octet_length(signed_receipt) > 0),
  signed_receipt_sha256 bytea NOT NULL CHECK (octet_length(signed_receipt_sha256) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_receipts_time_check CHECK (expires_at > issued_at)
);

CREATE INDEX materialization_receipts_expiry_idx
  ON materialization_receipts (expires_at, receipt_id);
