CREATE INDEX package_versions_management_page_idx
  ON package_versions (package_id, edition_id, created_at DESC, id DESC)
  WHERE state <> 'DELETED';
