ALTER TABLE materialization_jobs
  ADD COLUMN progress_sequence bigint NOT NULL DEFAULT 0
    CHECK (progress_sequence >= 0),
  ADD COLUMN progress jsonb,
  ADD COLUMN progress_updated_at timestamptz;

ALTER TABLE materialization_jobs
  ADD CONSTRAINT materialization_jobs_progress_check CHECK (
    (
      progress_sequence = 0
      AND progress IS NULL
      AND progress_updated_at IS NULL
    )
    OR (
      progress_sequence > 0
      AND jsonb_typeof(progress) = 'object'
      AND progress_updated_at IS NOT NULL
    )
  );
