ALTER TABLE package_install_dpop_replays
  DROP CONSTRAINT package_install_dpop_replays_expiry_check;

ALTER TABLE package_install_dpop_replays
  ADD CONSTRAINT package_install_dpop_replays_expiry_check
  CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '5 minutes 5 seconds'
  );
