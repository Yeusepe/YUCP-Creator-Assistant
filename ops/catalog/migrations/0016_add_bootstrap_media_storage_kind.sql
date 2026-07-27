ALTER TABLE package_release_storage_objects
  DROP CONSTRAINT package_release_storage_objects_logical_kind_check;

ALTER TABLE package_release_storage_objects
  ADD CONSTRAINT package_release_storage_objects_logical_kind_check
  CHECK (
    logical_kind IN (
      'bootstrap-media',
      'chunk',
      'delivery-binding',
      'file-table',
      'manifest',
      'membership'
    )
  );
