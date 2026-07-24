ALTER TABLE storage_write_intents
  ADD COLUMN candidate_object_version_id uuid REFERENCES storage_object_versions(id);

CREATE INDEX storage_write_intents_candidate_object_idx
  ON storage_write_intents (candidate_object_version_id, state)
  WHERE candidate_object_version_id IS NOT NULL;

CREATE TABLE storage_gc_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  previous_completed_generation_id bigint REFERENCES storage_gc_generations(id),
  state text NOT NULL CHECK (state IN ('OPEN', 'COMPLETED', 'FAILED')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error text,
  CONSTRAINT storage_gc_generations_terminal_check CHECK (
    (state = 'OPEN' AND completed_at IS NULL AND error IS NULL)
    OR (state = 'COMPLETED' AND completed_at IS NOT NULL AND error IS NULL)
    OR (state = 'FAILED' AND completed_at IS NOT NULL AND error IS NOT NULL)
  )
);

CREATE UNIQUE INDEX storage_gc_one_open_generation_idx
  ON storage_gc_generations (state)
  WHERE state = 'OPEN';

CREATE TABLE storage_gc_release_pins (
  id uuid PRIMARY KEY,
  package_version_id uuid NOT NULL REFERENCES package_versions(id),
  pin_kind text NOT NULL CHECK (
    pin_kind IN (
      'active-grant',
      'delivery-binding',
      'explicit',
      'legal-hold',
      'materialization-job',
      'promotion-job',
      'rendition-job',
      'rollback'
    )
  ),
  owner_id text NOT NULL CHECK (btrim(owner_id) <> '' AND length(owner_id) <= 512),
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (package_version_id, pin_kind, owner_id),
  CONSTRAINT storage_gc_release_pins_time_check CHECK (
    expires_at IS NULL OR expires_at > created_at
  )
);

CREATE INDEX storage_gc_release_pins_live_idx
  ON storage_gc_release_pins (package_version_id, expires_at, id)
  WHERE released_at IS NULL;

CREATE TABLE storage_gc_candidates (
  object_version_id uuid PRIMARY KEY REFERENCES storage_object_versions(id),
  first_generation_id bigint NOT NULL REFERENCES storage_gc_generations(id),
  last_generation_id bigint NOT NULL REFERENCES storage_gc_generations(id),
  consecutive_generations int NOT NULL CHECK (consecutive_generations >= 1),
  state text NOT NULL CHECK (
    state IN ('DELETED', 'DELETING', 'FAILED', 'OBSERVED', 'RETENTION_BLOCKED')
  ),
  last_error text,
  retention_until timestamptz,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT storage_gc_candidates_terminal_check CHECK (
    (state = 'DELETED' AND deleted_at IS NOT NULL AND last_error IS NULL)
    OR (state = 'DELETING' AND deleted_at IS NULL AND last_error IS NULL)
    OR (state = 'FAILED' AND deleted_at IS NULL AND last_error IS NOT NULL)
    OR (state = 'OBSERVED' AND deleted_at IS NULL AND last_error IS NULL)
    OR (
      state = 'RETENTION_BLOCKED'
      AND deleted_at IS NULL
      AND last_error IS NULL
      AND retention_until IS NOT NULL
    )
  )
);

CREATE INDEX storage_gc_candidates_sweep_idx
  ON storage_gc_candidates (
    last_generation_id,
    consecutive_generations,
    state,
    object_version_id
  )
  WHERE state IN ('FAILED', 'OBSERVED', 'RETENTION_BLOCKED');

CREATE TABLE storage_gc_deletion_journal (
  id uuid PRIMARY KEY,
  generation_id bigint NOT NULL REFERENCES storage_gc_generations(id),
  object_version_id uuid NOT NULL REFERENCES storage_object_versions(id),
  storage_role text NOT NULL CHECK (
    storage_role IN ('common', 'metadata', 'protected')
  ),
  bucket_name text NOT NULL CHECK (btrim(bucket_name) <> ''),
  object_key text NOT NULL CHECK (btrim(object_key) <> ''),
  provider_version text NOT NULL CHECK (btrim(provider_version) <> ''),
  state text NOT NULL CHECK (
    state IN ('DELETED', 'FAILED', 'RETENTION_BLOCKED', 'STARTED')
  ),
  retention_until timestamptz,
  error text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT storage_gc_deletion_journal_terminal_check CHECK (
    (state = 'STARTED' AND completed_at IS NULL AND error IS NULL)
    OR (state = 'DELETED' AND completed_at IS NOT NULL AND error IS NULL)
    OR (state = 'FAILED' AND completed_at IS NOT NULL AND error IS NOT NULL)
    OR (
      state = 'RETENTION_BLOCKED'
      AND completed_at IS NOT NULL
      AND error IS NULL
      AND retention_until IS NOT NULL
    )
  )
);

CREATE INDEX storage_gc_deletion_journal_object_idx
  ON storage_gc_deletion_journal (object_version_id, started_at, id);
