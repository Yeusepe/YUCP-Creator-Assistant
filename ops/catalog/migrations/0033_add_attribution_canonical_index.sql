-- Ordered to serve the attribution-candidates loose index scan: each probe
-- must find the next distinct attribution_id and its canonical row (newest
-- created_at, job_id tiebreak) in a single index descent.
CREATE INDEX materialization_attribution_records_canonical_idx
  ON materialization_attribution_records (attribution_id, created_at DESC, job_id DESC);
