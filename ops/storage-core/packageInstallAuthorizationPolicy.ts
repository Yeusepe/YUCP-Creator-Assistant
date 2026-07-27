// This deadline covers one admitted 5 GiB transfer, protected materialization, and repair.
// Fixed large-job admission prevents unbounded work during this period.
export const PACKAGE_INSTALL_AUTHORIZATION_POLICY = Object.freeze({
  grantLifetimeSeconds: 5 * 60,
  operationLifetimeSeconds: 4 * 60 * 60,
  renewalLeaseMilliseconds: 30 * 1_000,
});
