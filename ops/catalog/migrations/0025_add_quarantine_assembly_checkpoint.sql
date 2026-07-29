TRUNCATE TABLE package_quarantine_objects;

ALTER TABLE package_quarantine_objects
  ADD COLUMN creator_id text NOT NULL
    CHECK (btrim(creator_id) <> '' AND length(creator_id) <= 512),
  ADD COLUMN protection_policy_id text NOT NULL
    CHECK (
      btrim(protection_policy_id) <> ''
      AND length(protection_policy_id) <= 128
    );
