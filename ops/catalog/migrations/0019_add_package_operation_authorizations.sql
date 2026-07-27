CREATE TABLE package_operation_authorizations (
  capability_id text PRIMARY KEY
    CHECK (capability_id ~ '^operation-[0-9a-f]{48}$'),
  token_sha256 text NOT NULL
    CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  buyer_id text NOT NULL
    CHECK (btrim(buyer_id) <> '' AND length(buyer_id) <= 512),
  alias_id text NOT NULL
    CHECK (btrim(alias_id) <> '' AND length(alias_id) <= 512),
  device_key_thumbprint text NOT NULL
    CHECK (device_key_thumbprint ~ '^[0-9a-f]{64}$'),
  release_root text NOT NULL
    CHECK (release_root ~ '^[0-9a-f]{64}$'),
  expected_current_release_root text NOT NULL
    CHECK (expected_current_release_root ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL
    CHECK (
      operation IN (
        'install',
        'preflight',
        'recover',
        'repair',
        'rollback',
        'uninstall',
        'update'
      )
    ),
  project_identity text NOT NULL
    CHECK (project_identity ~ '^[0-9a-f]{64}$'),
  approved_active_content_digest text
    CHECK (
      approved_active_content_digest IS NULL
      OR approved_active_content_digest ~ '^[0-9a-f]{64}$'
    ),
  approved_policy_version text
    CHECK (
      approved_policy_version IS NULL
      OR (
        btrim(approved_policy_version) <> ''
        AND length(approved_policy_version) <= 512
      )
    ),
  idempotency_key text NOT NULL
    CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 512),
  traceparent text NOT NULL
    CHECK (
      traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$'
      AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
      AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    ),
  one_use_nonce text NOT NULL
    CHECK (one_use_nonce ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  exchange_state text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (exchange_state IN ('AVAILABLE', 'PROCESSING', 'READY')),
  exchange_generation integer NOT NULL DEFAULT 0
    CHECK (exchange_generation >= 0),
  exchange_lease_until timestamptz,
  exchange_completed_at timestamptz,
  outcome_session_id text,
  outcome_delivery_grant_id text,
  outcome_materialization_job_id text,
  outcome_version_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_operation_authorizations_time_check
    CHECK (
      expires_at > issued_at
      AND expires_at <= issued_at + interval '5 minutes'
    ),
  CONSTRAINT package_operation_authorizations_approval_check
    CHECK (
      (
        operation = 'preflight'
        AND approved_active_content_digest IS NULL
        AND approved_policy_version IS NULL
      )
      OR (
        operation <> 'preflight'
        AND approved_active_content_digest IS NOT NULL
        AND approved_policy_version IS NOT NULL
      )
    ),
  CONSTRAINT package_operation_authorizations_idempotency_unique
    UNIQUE (buyer_id, device_key_thumbprint, idempotency_key),
  CONSTRAINT package_operation_authorizations_exchange_check
    CHECK (
      (
        exchange_state = 'AVAILABLE'
        AND exchange_lease_until IS NULL
        AND exchange_completed_at IS NULL
      )
      OR (
        exchange_state = 'PROCESSING'
        AND consumed_at IS NOT NULL
        AND exchange_lease_until IS NOT NULL
        AND exchange_completed_at IS NULL
      )
      OR (
        exchange_state = 'READY'
        AND consumed_at IS NOT NULL
        AND exchange_lease_until IS NULL
        AND exchange_completed_at IS NOT NULL
        AND outcome_session_id IS NOT NULL
        AND outcome_delivery_grant_id IS NOT NULL
        AND outcome_version_id IS NOT NULL
      )
    )
);

CREATE INDEX package_operation_authorizations_expiry_idx
  ON package_operation_authorizations (expires_at, capability_id)
  WHERE consumed_at IS NULL;

CREATE TABLE package_install_dpop_replays (
  replay_key text PRIMARY KEY
    CHECK (btrim(replay_key) <> '' AND length(replay_key) <= 1024),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_install_dpop_replays_expiry_check
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '5 minutes'
    )
);

CREATE INDEX package_install_dpop_replays_expiry_idx
  ON package_install_dpop_replays (expires_at);
