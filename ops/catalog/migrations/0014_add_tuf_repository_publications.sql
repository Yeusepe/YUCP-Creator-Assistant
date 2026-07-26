CREATE TABLE tuf_repositories (
  repository_id text PRIMARY KEY
    CHECK (
      repository_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'
    ),
  next_metadata_version bigint NOT NULL DEFAULT 1
    CHECK (next_metadata_version >= 1),
  active_publication_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tuf_publications (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL REFERENCES tuf_repositories(repository_id),
  idempotency_key text NOT NULL
    CHECK (
      btrim(idempotency_key) <> ''
      AND length(idempotency_key) <= 512
    ),
  metadata_version bigint NOT NULL CHECK (metadata_version >= 1),
  root_version bigint NOT NULL CHECK (root_version >= 1),
  timestamp_expires_at timestamptz NOT NULL,
  snapshot_expires_at timestamptz NOT NULL,
  targets_expires_at timestamptz NOT NULL,
  expected_paths jsonb NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  CONSTRAINT tuf_publications_paths_check CHECK (
    jsonb_typeof(expected_paths) = 'array'
    AND jsonb_array_length(expected_paths) >= 4
    AND jsonb_array_length(expected_paths) <= 100004
    AND octet_length(expected_paths::text) <= 67108864
  ),
  CONSTRAINT tuf_publications_expiry_check CHECK (
    timestamp_expires_at < snapshot_expires_at
    AND snapshot_expires_at < targets_expires_at
  ),
  CONSTRAINT tuf_publications_state_value_check CHECK (
    state IN ('RESERVED', 'PUBLISHING', 'PUBLISHED', 'FAILED')
  ),
  CONSTRAINT tuf_publications_state_check CHECK (
    (
      state = 'PUBLISHED'
      AND published_at IS NOT NULL
    )
    OR (
      state <> 'PUBLISHED'
      AND published_at IS NULL
    )
  ),
  UNIQUE (repository_id, metadata_version),
  UNIQUE (repository_id, idempotency_key)
);

ALTER TABLE tuf_repositories
  ADD CONSTRAINT tuf_repositories_active_publication_fk
  FOREIGN KEY (active_publication_id) REFERENCES tuf_publications(id);

CREATE TABLE tuf_publication_objects (
  publication_id uuid NOT NULL REFERENCES tuf_publications(id) ON DELETE CASCADE,
  repository_path text NOT NULL
    CHECK (
      btrim(repository_path) <> ''
      AND length(repository_path) <= 2048
    ),
  object_version_id uuid NOT NULL REFERENCES storage_object_versions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, repository_path)
);

CREATE INDEX tuf_publication_objects_lookup_idx
  ON tuf_publication_objects (repository_path, publication_id);

CREATE FUNCTION tuf_record_publication_object(
  publication_identifier uuid,
  repository_object_path text,
  exact_object_identifier uuid,
  exact_provider_version text,
  exact_file_identifier text
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  publication tuf_publications%ROWTYPE;
  existing_object_identifier uuid;
BEGIN
  SELECT *
  INTO publication
  FROM tuf_publications
  WHERE id = publication_identifier
  FOR UPDATE;

  IF NOT FOUND OR publication.state NOT IN ('RESERVED', 'PUBLISHING') THEN
    RAISE EXCEPTION 'TUF publication does not accept object records';
  END IF;

  IF NOT (publication.expected_paths ? repository_object_path) THEN
    RAISE EXCEPTION 'TUF object path is not part of the reserved publication';
  END IF;

  PERFORM 1
  FROM storage_object_versions
  WHERE id = exact_object_identifier
    AND storage_role = 'metadata'
    AND object_key = (
      'v2/metadata/tuf/'
      || publication.repository_id
      || '/'
      || repository_object_path
    )
    AND provider_version = exact_provider_version
    AND file_identifier = exact_file_identifier
    AND verification_state = 'VERIFIED'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TUF object is not one verified exact metadata version';
  END IF;

  SELECT object_version_id
  INTO existing_object_identifier
  FROM tuf_publication_objects
  WHERE publication_id = publication_identifier
    AND repository_path = repository_object_path;

  IF FOUND THEN
    IF existing_object_identifier <> exact_object_identifier THEN
      RAISE EXCEPTION 'Recorded TUF object is immutable';
    END IF;
    RETURN 'EXISTING';
  END IF;

  IF repository_object_path = 'metadata/timestamp.json'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(publication.expected_paths) expected(path)
      WHERE expected.path <> 'metadata/timestamp.json'
        AND NOT EXISTS (
          SELECT 1
          FROM tuf_publication_objects recorded
          WHERE recorded.publication_id = publication_identifier
            AND recorded.repository_path = expected.path
        )
    )
  THEN
    RAISE EXCEPTION 'TUF timestamp must be recorded last';
  END IF;

  INSERT INTO tuf_publication_objects (
    publication_id,
    repository_path,
    object_version_id
  )
  VALUES (
    publication_identifier,
    repository_object_path,
    exact_object_identifier
  );

  UPDATE tuf_publications
  SET state = 'PUBLISHING', updated_at = clock_timestamp()
  WHERE id = publication_identifier;

  RETURN 'INSERT';
END;
$$;

CREATE FUNCTION tuf_publish_repository(publication_identifier uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  publication tuf_publications%ROWTYPE;
BEGIN
  SELECT *
  INTO publication
  FROM tuf_publications
  WHERE id = publication_identifier
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TUF publication was not found';
  END IF;

  IF publication.state = 'PUBLISHED' THEN
    RETURN 'EXISTING';
  END IF;

  IF publication.state <> 'PUBLISHING'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(publication.expected_paths) expected(path)
      WHERE NOT EXISTS (
        SELECT 1
        FROM tuf_publication_objects recorded
        WHERE recorded.publication_id = publication_identifier
          AND recorded.repository_path = expected.path
      )
    )
    OR (
      SELECT count(*)
      FROM tuf_publication_objects
      WHERE publication_id = publication_identifier
    ) <> jsonb_array_length(publication.expected_paths)
  THEN
    RAISE EXCEPTION 'TUF publication is incomplete';
  END IF;

  UPDATE tuf_publications
  SET
    state = 'PUBLISHED',
    published_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE id = publication_identifier;

  UPDATE tuf_repositories
  SET
    active_publication_id = publication_identifier,
    updated_at = clock_timestamp()
  WHERE repository_id = publication.repository_id;

  RETURN 'PUBLISHED';
END;
$$;
