CREATE OR REPLACE FUNCTION tuf_record_publication_object(
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
  FROM storage_object_versions object
  LEFT JOIN storage_gc_candidates candidate
    ON candidate.object_version_id = object.id
  WHERE object.id = exact_object_identifier
    AND object.storage_role = 'metadata'
    AND object.object_key = (
      'v2/metadata/tuf/'
      || publication.repository_id
      || '/'
      || repository_object_path
    )
    AND object.provider_version = exact_provider_version
    AND object.file_identifier = exact_file_identifier
    AND object.verification_state = 'VERIFIED'
    AND (
      candidate.state IS NULL
      OR candidate.state NOT IN ('DELETING', 'DELETED')
    )
  FOR UPDATE OF object;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TUF object is not one available verified exact metadata version';
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
