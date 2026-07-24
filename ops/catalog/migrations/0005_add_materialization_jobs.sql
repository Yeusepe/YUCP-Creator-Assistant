CREATE TABLE materialization_jobs (
  id text PRIMARY KEY CHECK (btrim(id) <> '' AND length(id) <= 128),
  creator_id text NOT NULL CHECK (btrim(creator_id) <> '' AND length(creator_id) <= 512),
  product_id text NOT NULL CHECK (btrim(product_id) <> '' AND length(product_id) <= 512),
  buyer_subject_pseudonym text NOT NULL
    CHECK (btrim(buyer_subject_pseudonym) <> '' AND length(buyer_subject_pseudonym) <= 512),
  pseudonym_method text NOT NULL
    CHECK (btrim(pseudonym_method) <> '' AND length(pseudonym_method) <= 128),
  release_root bytea NOT NULL CHECK (octet_length(release_root) = 32),
  delivery_binding_root bytea NOT NULL CHECK (octet_length(delivery_binding_root) = 32),
  protected_source_root bytea NOT NULL CHECK (octet_length(protected_source_root) = 32),
  source_version_id uuid NOT NULL REFERENCES package_versions(id),
  source_manifest_sha256 bytea NOT NULL CHECK (octet_length(source_manifest_sha256) = 32),
  source_logical_bytes bigint NOT NULL CHECK (
    source_logical_bytes >= 0 AND source_logical_bytes <= 68719476736
  ),
  source_logical_files int NOT NULL CHECK (
    source_logical_files > 0 AND source_logical_files <= 100000
  ),
  materialization_algorithm text NOT NULL
    CHECK (btrim(materialization_algorithm) <> '' AND length(materialization_algorithm) <= 512),
  plugin_version text NOT NULL
    CHECK (btrim(plugin_version) <> '' AND length(plugin_version) <= 512),
  output_format text NOT NULL CHECK (output_format IN ('overlay', 'zip')),
  key_epoch int NOT NULL CHECK (key_epoch >= 0),
  grant_jti text NOT NULL CHECK (btrim(grant_jti) <> '' AND length(grant_jti) <= 512),
  protected_files jsonb NOT NULL,
  lane text NOT NULL DEFAULT 'large' CHECK (lane IN ('large', 'maintenance')),
  state text NOT NULL DEFAULT 'QUEUED'
    CHECK (state IN ('QUEUED', 'MATERIALIZING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  lease_owner text,
  lease_generation int NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_jobs_files_check CHECK (
    jsonb_typeof(protected_files) = 'array'
    AND jsonb_array_length(protected_files) BETWEEN 1 AND 512
  ),
  CONSTRAINT materialization_jobs_lease_check CHECK (
    (
      state IN ('MATERIALIZING', 'VERIFYING')
      AND lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL
      AND heartbeat_at IS NOT NULL
      AND lease_generation > 0
    )
    OR (
      state NOT IN ('MATERIALIZING', 'VERIFYING')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND heartbeat_at IS NULL
    )
  )
);

CREATE INDEX materialization_jobs_claim_idx
  ON materialization_jobs (lane, created_at, id)
  WHERE state = 'QUEUED';

CREATE UNIQUE INDEX materialization_jobs_active_lane_idx
  ON materialization_jobs (lease_owner, lane)
  WHERE state IN ('MATERIALIZING', 'VERIFYING');

CREATE TABLE materialization_capabilities (
  capability_id text PRIMARY KEY
    CHECK (btrim(capability_id) <> '' AND length(capability_id) <= 128),
  job_id text NOT NULL REFERENCES materialization_jobs(id),
  lease_generation int NOT NULL CHECK (lease_generation > 0),
  one_use_nonce bytea NOT NULL UNIQUE CHECK (octet_length(one_use_nonce) = 32),
  proof_key_thumbprint bytea NOT NULL CHECK (octet_length(proof_key_thumbprint) = 32),
  signed_capability_sha256 bytea NOT NULL
    CHECK (octet_length(signed_capability_sha256) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text,
  recipient_public_key_sha256 bytea,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_capabilities_time_check CHECK (expires_at > issued_at),
  CONSTRAINT materialization_capabilities_consumption_check CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL AND recipient_public_key_sha256 IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND consumed_by IS NOT NULL
      AND btrim(consumed_by) <> ''
      AND recipient_public_key_sha256 IS NOT NULL
      AND octet_length(recipient_public_key_sha256) = 32
    )
  ),
  CONSTRAINT materialization_capabilities_job_fence_unique
    UNIQUE (capability_id, job_id, lease_generation)
);

CREATE INDEX materialization_capabilities_expiry_idx
  ON materialization_capabilities (expires_at, capability_id)
  WHERE consumed_at IS NULL;

CREATE TABLE materialization_dpop_proofs (
  proof_key_thumbprint bytea NOT NULL CHECK (octet_length(proof_key_thumbprint) = 32),
  proof_jti text NOT NULL CHECK (btrim(proof_jti) <> '' AND length(proof_jti) <= 128),
  capability_id text NOT NULL REFERENCES materialization_capabilities(capability_id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proof_key_thumbprint, proof_jti)
);

CREATE INDEX materialization_dpop_proofs_expiry_idx
  ON materialization_dpop_proofs (expires_at);

CREATE TABLE materialization_source_grants (
  grant_id text PRIMARY KEY CHECK (btrim(grant_id) <> '' AND length(grant_id) <= 128),
  job_id text NOT NULL REFERENCES materialization_jobs(id),
  lease_generation int NOT NULL CHECK (lease_generation > 0),
  source_version_id uuid NOT NULL REFERENCES package_versions(id),
  proof_key_thumbprint bytea NOT NULL CHECK (octet_length(proof_key_thumbprint) = 32),
  signed_grant_sha256 bytea NOT NULL CHECK (octet_length(signed_grant_sha256) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_source_grants_time_check CHECK (expires_at > issued_at),
  CONSTRAINT materialization_source_grants_job_fence_unique
    UNIQUE (job_id, lease_generation)
);

CREATE INDEX materialization_source_grants_expiry_idx
  ON materialization_source_grants (expires_at, grant_id);

CREATE TABLE materialization_attribution_records (
  attribution_id text PRIMARY KEY
    CHECK (btrim(attribution_id) <> '' AND length(attribution_id) <= 512),
  job_id text NOT NULL REFERENCES materialization_jobs(id),
  capability_id text NOT NULL REFERENCES materialization_capabilities(capability_id),
  normalized_path text NOT NULL
    CHECK (btrim(normalized_path) <> '' AND length(normalized_path) <= 1024),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
  output_sha256 bytea NOT NULL CHECK (octet_length(output_sha256) = 32),
  attribution_token_hash bytea NOT NULL CHECK (octet_length(attribution_token_hash) = 32),
  encrypted_subject_mapping bytea NOT NULL CHECK (octet_length(encrypted_subject_mapping) > 0),
  key_epoch int NOT NULL CHECK (key_epoch >= 0),
  algorithm_version text NOT NULL
    CHECK (btrim(algorithm_version) <> '' AND length(algorithm_version) <= 512),
  plugin_version text NOT NULL
    CHECK (btrim(plugin_version) <> '' AND length(plugin_version) <= 512),
  output_format text NOT NULL CHECK (output_format IN ('overlay', 'zip')),
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT materialization_attribution_output_unique
    UNIQUE (output_sha256, normalized_path, attribution_id)
);
