export const PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS = 5 * 60;

/**
 * Better Auth accepts proof timestamps up to five seconds in the future.
 * The replay reservation must cover that accepted skew in addition to the
 * proof age or a valid proof is indistinguishable from a replay-store failure.
 *
 * Source: https://github.com/better-auth/better-auth/blob/v1.7.0-rc.2/packages/core/src/oauth2/dpop.ts
 */
export const PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS = 5;

export const PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS =
  (PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS + PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS) *
  1_000;
