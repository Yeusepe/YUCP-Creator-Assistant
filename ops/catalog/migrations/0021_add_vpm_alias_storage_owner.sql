ALTER TABLE storage_write_intents
  DROP CONSTRAINT storage_write_intents_owner_kind_check;

ALTER TABLE storage_write_intents
  ADD CONSTRAINT storage_write_intents_owner_kind_check
  CHECK (
    owner_kind IN (
      'package-version',
      'materialization-job',
      'maintenance',
      'vpm-alias-publication'
    )
  );
