ALTER TABLE package_versions
  ADD COLUMN edition_id text NOT NULL DEFAULT 'standard'
  CHECK (
    edition_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
  );

ALTER TABLE package_versions
  DROP CONSTRAINT package_versions_package_version_unique;

ALTER TABLE package_versions
  ADD CONSTRAINT package_versions_package_version_unique
  UNIQUE (package_id, edition_id, version);
