ALTER TABLE materialization_attribution_records
  DROP CONSTRAINT materialization_attribution_records_pkey;

ALTER TABLE materialization_attribution_records
  DROP CONSTRAINT materialization_attribution_output_unique;

ALTER TABLE materialization_attribution_records
  ADD CONSTRAINT materialization_attribution_records_pkey
    PRIMARY KEY (job_id, attribution_id);

CREATE INDEX materialization_attribution_records_attribution_idx
  ON materialization_attribution_records (attribution_id, created_at DESC);
