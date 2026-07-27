CREATE INDEX package_release_storage_objects_object_idx
  ON package_release_storage_objects (object_version_id, package_version_id);

CREATE INDEX storage_write_intents_object_state_idx
  ON storage_write_intents (object_version_id, state)
  WHERE object_version_id IS NOT NULL;
