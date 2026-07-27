ALTER TABLE package_versions
  ADD COLUMN vpm_dependencies jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN vpm_repositories jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE package_versions
  ADD CONSTRAINT package_versions_vpm_dependencies_check CHECK (
    jsonb_typeof(vpm_dependencies) = 'object'
    AND octet_length(vpm_dependencies::text) <= 16384
  ),
  ADD CONSTRAINT package_versions_vpm_repositories_check CHECK (
    jsonb_typeof(vpm_repositories) = 'object'
    AND octet_length(vpm_repositories::text) <= 32768
  );
