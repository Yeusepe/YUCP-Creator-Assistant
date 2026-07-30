CREATE TABLE materialization_dispatch_outbox (
  job_id text PRIMARY KEY REFERENCES materialization_jobs(id) ON DELETE CASCADE,
  trace_id text NOT NULL CHECK (btrim(trace_id) <> '' AND length(trace_id) <= 512),
  lane text NOT NULL CHECK (lane IN ('large', 'maintenance')),
  cache_affinity_key bytea NOT NULL CHECK (octet_length(cache_affinity_key) = 32),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'DISPATCHING', 'DISPATCHED', 'RETRY')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX materialization_dispatch_outbox_pending_idx
  ON materialization_dispatch_outbox (next_attempt_at, created_at, job_id)
  WHERE state IN ('PENDING', 'RETRY');

-- The relay claims no more than 100 rows inside one transaction. Concurrent
-- relays cannot claim the same job because the selection uses FOR UPDATE SKIP LOCKED.
CREATE FUNCTION materialization_dispatch_claim(p_limit int)
RETURNS SETOF materialization_dispatch_outbox
LANGUAGE sql
AS $$
  UPDATE materialization_dispatch_outbox AS outbox
  SET
    state = 'DISPATCHING',
    attempts = attempts + 1,
    updated_at = clock_timestamp()
  FROM (
    SELECT job_id
    FROM materialization_dispatch_outbox
    WHERE
      state IN ('PENDING', 'RETRY')
      AND next_attempt_at <= clock_timestamp()
    ORDER BY next_attempt_at, created_at, job_id
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  ) AS claimed
  WHERE outbox.job_id = claimed.job_id
  RETURNING outbox.*;
$$;
