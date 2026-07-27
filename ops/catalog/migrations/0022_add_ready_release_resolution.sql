CREATE INDEX package_versions_ready_release_resolution_idx
  ON package_versions (package_id, edition_id, release_root)
  WHERE state = 'READY' AND deleted_at IS NULL;
