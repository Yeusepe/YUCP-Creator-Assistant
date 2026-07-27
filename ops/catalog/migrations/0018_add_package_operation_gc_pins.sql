CREATE FUNCTION storage_gc_acquire_release_pin(
  requested_pin_id uuid,
  requested_package_version_id uuid,
  requested_pin_kind text,
  requested_owner_id text,
  requested_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  acquired_pin_id uuid;
BEGIN
  IF requested_pin_kind NOT IN (
    'active-grant',
    'delivery-binding',
    'explicit',
    'legal-hold',
    'materialization-job',
    'promotion-job',
    'rendition-job',
    'rollback'
  ) THEN
    RAISE EXCEPTION 'Storage GC pin kind is invalid';
  END IF;

  IF requested_expires_at IS NOT NULL
    AND requested_expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Storage GC pin expiry must be in the future';
  END IF;

  PERFORM 1
  FROM package_versions
  WHERE id = requested_package_version_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage GC pin package version was not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM package_release_storage_objects release_object
    JOIN storage_object_versions object
      ON object.id = release_object.object_version_id
    LEFT JOIN storage_gc_candidates candidate
      ON candidate.object_version_id = object.id
    WHERE release_object.package_version_id = requested_package_version_id
      AND (
        object.verification_state <> 'VERIFIED'
        OR candidate.state IN ('DELETING', 'DELETED')
      )
    FOR UPDATE OF object
  ) THEN
    RAISE EXCEPTION 'Storage GC pin cannot reference an object that is deleting or deleted';
  END IF;

  INSERT INTO storage_gc_release_pins (
    id,
    package_version_id,
    pin_kind,
    owner_id,
    expires_at
  )
  VALUES (
    requested_pin_id,
    requested_package_version_id,
    requested_pin_kind,
    requested_owner_id,
    requested_expires_at
  )
  ON CONFLICT (package_version_id, pin_kind, owner_id)
  DO UPDATE SET
    expires_at = EXCLUDED.expires_at,
    released_at = NULL,
    updated_at = clock_timestamp()
  RETURNING id INTO acquired_pin_id;

  RETURN acquired_pin_id;
END;
$$;

CREATE INDEX tuf_publication_objects_gc_root_idx
  ON tuf_publication_objects (object_version_id, publication_id);

UPDATE materialization_jobs
SET
  state = 'FAILED',
  last_error_code = COALESCE(last_error_code, 'MATERIALIZATION_CANCELLED'),
  lease_owner = NULL,
  lease_expires_at = NULL,
  heartbeat_at = NULL,
  updated_at = clock_timestamp()
WHERE state = 'CANCELLED';

ALTER TABLE materialization_jobs
  DROP CONSTRAINT materialization_jobs_state_check,
  ADD CONSTRAINT materialization_jobs_state_check
    CHECK (state IN ('QUEUED', 'MATERIALIZING', 'VERIFYING', 'SUCCEEDED', 'FAILED'));

ALTER TABLE materialization_jobs
  ADD COLUMN storage_gc_pin_id uuid;

INSERT INTO storage_gc_release_pins (
  id,
  package_version_id,
  pin_kind,
  owner_id,
  expires_at,
  released_at
)
SELECT
  gen_random_uuid(),
  job.source_version_id,
  'materialization-job',
  job.id,
  clock_timestamp() + interval '7 days',
  CASE
    WHEN job.state IN ('SUCCEEDED', 'FAILED')
      THEN clock_timestamp()
    ELSE NULL
  END
FROM materialization_jobs job
ON CONFLICT (package_version_id, pin_kind, owner_id)
DO NOTHING;

UPDATE materialization_jobs job
SET storage_gc_pin_id = pin.id
FROM storage_gc_release_pins pin
WHERE pin.package_version_id = job.source_version_id
  AND pin.pin_kind = 'materialization-job'
  AND pin.owner_id = job.id;

ALTER TABLE materialization_jobs
  ALTER COLUMN storage_gc_pin_id SET NOT NULL,
  ADD CONSTRAINT materialization_jobs_storage_gc_pin_fk
    FOREIGN KEY (storage_gc_pin_id) REFERENCES storage_gc_release_pins(id),
  ADD CONSTRAINT materialization_jobs_storage_gc_pin_unique
    UNIQUE (storage_gc_pin_id);
