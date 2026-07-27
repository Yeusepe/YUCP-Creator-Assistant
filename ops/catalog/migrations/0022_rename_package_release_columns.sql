ALTER TABLE package_versions
  RENAME COLUMN format_tag TO source_format;

ALTER TABLE package_versions
  RENAME COLUMN canonical_sha256 TO release_root;

ALTER TABLE package_versions
  RENAME COLUMN cas_index_id TO assembly_object_id;

ALTER TABLE package_versions
  RENAME CONSTRAINT package_versions_cas_index_id_check
  TO package_versions_assembly_object_id_check;

CREATE INDEX package_versions_ready_release_resolution_idx
  ON package_versions (package_id, edition_id, release_root)
  WHERE state = 'READY' AND deleted_at IS NULL;
