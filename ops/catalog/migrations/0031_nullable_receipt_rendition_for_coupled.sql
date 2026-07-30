-- Coupled (receipt v3) completions deliver per-file outputs and have no monolithic
-- rendition object, so the rendition identity columns are meaningless for them. They
-- previously stored deterministic stand-ins (output tree root, output file count, the
-- coupled manifest key) to satisfy NOT NULL; store honest NULLs instead. The shape
-- check keeps rows all-or-nothing so a v2 receipt can never lose part of its rendition
-- identity and a v3 receipt can never carry a partial one.
--
-- Lock impact: each ALTER takes a brief ACCESS EXCLUSIVE lock; DROP NOT NULL and
-- ADD CONSTRAINT ... NOT VALID are metadata-only (no scan, no rewrite). The separate
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, scanning without blocking reads or writes.
-- Every pre-existing row had all three columns NOT NULL, so validation cannot fail.
--
-- Rollback: ALTER TABLE materialization_receipts
--   DROP CONSTRAINT materialization_receipts_rendition_shape_check;
-- Restoring SET NOT NULL on the three columns is only possible while no v3 (all-NULL)
-- rows exist; once coupled receipts land, roll forward instead.
-- Validation query (must return 0 rows):
--   SELECT id FROM materialization_receipts
--   WHERE (object_sha256 IS NULL) <> (object_bytes IS NULL)
--      OR (object_sha256 IS NULL) <> (file_identifier IS NULL);
ALTER TABLE materialization_receipts
  ALTER COLUMN object_sha256 DROP NOT NULL,
  ALTER COLUMN object_bytes DROP NOT NULL,
  ALTER COLUMN file_identifier DROP NOT NULL;

ALTER TABLE materialization_receipts
  ADD CONSTRAINT materialization_receipts_rendition_shape_check
  CHECK (
    (
      object_sha256 IS NOT NULL
      AND object_bytes IS NOT NULL
      AND file_identifier IS NOT NULL
    )
    OR (
      object_sha256 IS NULL
      AND object_bytes IS NULL
      AND file_identifier IS NULL
    )
  ) NOT VALID;

-- Existing rows predate the nullability change and were NOT NULL, so validation is a
-- non-blocking scan that trivially succeeds.
ALTER TABLE materialization_receipts
  VALIDATE CONSTRAINT materialization_receipts_rendition_shape_check;
