import { createHash } from 'node:crypto';
import { parseTraceparent } from '@yucp/shared';
import { PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS } from '../storage-core/dpopReplayPolicy';
import { PACKAGE_INSTALL_AUTHORIZATION_POLICY } from '../storage-core/packageInstallAuthorizationPolicy';
import type { CatalogDatabase } from './database';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_ID_PATTERN = /^operation-[0-9a-f]{48}$/;
const MAX_CAPABILITY_LIFETIME_MS = 5 * 60 * 1_000;

export type PackageOperationAuthorizationRecord = {
  aliasId: string;
  approvedActiveContentDigest?: string;
  approvedPolicyVersion?: string;
  buyerId: string;
  capabilityId: string;
  consumedAt?: Date;
  deviceKeyThumbprint: string;
  expectedCurrentReleaseRoot: string;
  expiresAt: Date;
  idempotencyKey: string;
  issuedAt: Date;
  operation: 'install' | 'preflight' | 'recover' | 'repair' | 'rollback' | 'uninstall' | 'update';
  oneUseNonce: string;
  projectIdentity: string;
  releaseRoot: string;
  tokenSha256: string;
  traceparent: string;
};

type AuthorizationRow = {
  alias_id: string;
  approved_active_content_digest: string | null;
  approved_policy_version: string | null;
  buyer_id: string;
  capability_id: string;
  consumed_at: Date | null;
  device_key_thumbprint: string;
  expected_current_release_root: string;
  expires_at: Date;
  exchange_generation: number;
  exchange_state: 'AVAILABLE' | 'PROCESSING' | 'READY';
  idempotency_key: string;
  issued_at: Date;
  operation: PackageOperationAuthorizationRecord['operation'];
  one_use_nonce: string;
  project_identity: string;
  release_root: string;
  token_sha256: string;
  traceparent: string;
};

export type PackageOperationExchangeClaim =
  | { generation: number; status: 'claimed' }
  | { status: 'in_progress' }
  | { status: 'invalid' }
  | {
      deliveryGrantId: string;
      grantExpiresAt: Date;
      grantIssuedAt: Date;
      grantTokenSha256: string;
      materializationJobId?: string;
      renewableUntil: Date;
      sessionId: string;
      status: 'ready';
      versionId: string;
    };

export type PackageOperationAuthorizationReservation =
  | { record: PackageOperationAuthorizationRecord; status: 'created' | 'existing' }
  | { record: PackageOperationAuthorizationRecord; status: 'consumed' | 'conflict' };

export type PackageOperationRenewalClaim =
  | {
      capabilityId: string;
      generation: number;
      grantId: string;
      issuedAt: Date;
      renewableUntil: Date;
      status: 'claimed';
    }
  | { status: 'in_progress' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | {
      capabilityId: string;
      generation: number;
      grantId: string;
      expiresAt: Date;
      grantTokenSha256: string;
      issuedAt: Date;
      renewableUntil: Date;
      status: 'ready';
    };

function requireDigest(value: string, name: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireText(value: string, name: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value || value.length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateRecord(record: PackageOperationAuthorizationRecord): void {
  if (!CAPABILITY_ID_PATTERN.test(record.capabilityId)) {
    throw new Error('capabilityId is invalid');
  }
  requireDigest(record.tokenSha256, 'tokenSha256');
  requireDigest(record.deviceKeyThumbprint, 'deviceKeyThumbprint');
  requireDigest(record.releaseRoot, 'releaseRoot');
  requireDigest(record.projectIdentity, 'projectIdentity');
  requireDigest(record.expectedCurrentReleaseRoot, 'expectedCurrentReleaseRoot');
  requireText(record.buyerId, 'buyerId');
  requireText(record.aliasId, 'aliasId');
  requireText(record.idempotencyKey, 'idempotencyKey');
  requireDigest(record.oneUseNonce, 'oneUseNonce');
  if (!parseTraceparent(record.traceparent)) {
    throw new Error('traceparent is invalid');
  }
  const hasApproval =
    record.approvedActiveContentDigest !== undefined || record.approvedPolicyVersion !== undefined;
  if (record.operation === 'preflight') {
    if (hasApproval) {
      throw new Error('preflight authorization must not include content approval');
    }
  } else {
    requireDigest(record.approvedActiveContentDigest ?? '', 'approvedActiveContentDigest');
    requireText(record.approvedPolicyVersion ?? '', 'approvedPolicyVersion');
  }
  const lifetime = record.expiresAt.getTime() - record.issuedAt.getTime();
  if (
    !Number.isFinite(record.issuedAt.getTime()) ||
    !Number.isFinite(record.expiresAt.getTime()) ||
    lifetime <= 0 ||
    lifetime > MAX_CAPABILITY_LIFETIME_MS
  ) {
    throw new Error('package operation authorization lifetime is invalid');
  }
}

function mapRow(row: AuthorizationRow): PackageOperationAuthorizationRecord {
  return {
    aliasId: row.alias_id,
    buyerId: row.buyer_id,
    capabilityId: row.capability_id,
    deviceKeyThumbprint: row.device_key_thumbprint,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    issuedAt: row.issued_at,
    operation: row.operation,
    oneUseNonce: row.one_use_nonce,
    projectIdentity: row.project_identity,
    releaseRoot: row.release_root,
    tokenSha256: row.token_sha256,
    traceparent: row.traceparent,
    ...(row.approved_active_content_digest
      ? { approvedActiveContentDigest: row.approved_active_content_digest }
      : {}),
    ...(row.approved_policy_version ? { approvedPolicyVersion: row.approved_policy_version } : {}),
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    expectedCurrentReleaseRoot: row.expected_current_release_root,
  };
}

function recordsMatch(
  left: PackageOperationAuthorizationRecord,
  right: PackageOperationAuthorizationRecord
): boolean {
  return (
    left.aliasId === right.aliasId &&
    left.approvedActiveContentDigest === right.approvedActiveContentDigest &&
    left.approvedPolicyVersion === right.approvedPolicyVersion &&
    left.buyerId === right.buyerId &&
    left.deviceKeyThumbprint === right.deviceKeyThumbprint &&
    left.expectedCurrentReleaseRoot === right.expectedCurrentReleaseRoot &&
    left.idempotencyKey === right.idempotencyKey &&
    left.operation === right.operation &&
    left.projectIdentity === right.projectIdentity &&
    left.releaseRoot === right.releaseRoot
  );
}

export class PackageOperationAuthorizationStore {
  readonly #database: CatalogDatabase;

  constructor(database: CatalogDatabase) {
    this.#database = database;
  }

  async reserve(
    requested: PackageOperationAuthorizationRecord
  ): Promise<PackageOperationAuthorizationReservation> {
    validateRecord(requested);
    await this.#database`
      DELETE FROM package_operation_authorizations
      WHERE ctid IN (
        SELECT ctid
        FROM package_operation_authorizations
        WHERE (
            exchange_state <> 'READY'
            AND expires_at <= clock_timestamp()
            AND (
              exchange_state <> 'PROCESSING'
              OR exchange_lease_until <= clock_timestamp()
            )
          )
          OR (
            exchange_state = 'READY'
            AND session_renewable_until <= clock_timestamp()
            AND (
              renewal_state <> 'PROCESSING'
              OR renewal_lease_until <= clock_timestamp()
            )
          )
        ORDER BY expires_at
        LIMIT 100
      )
    `;
    const inserted = await this.#database<AuthorizationRow[]>`
      INSERT INTO package_operation_authorizations (
        capability_id,
        token_sha256,
        buyer_id,
        alias_id,
        device_key_thumbprint,
        release_root,
        expected_current_release_root,
        operation,
        one_use_nonce,
        project_identity,
        approved_active_content_digest,
        approved_policy_version,
        idempotency_key,
        traceparent,
        issued_at,
        expires_at
      )
      VALUES (
        ${requested.capabilityId},
        ${requested.tokenSha256},
        ${requested.buyerId},
        ${requested.aliasId},
        ${requested.deviceKeyThumbprint},
        ${requested.releaseRoot},
        ${requested.expectedCurrentReleaseRoot},
        ${requested.operation},
        ${requested.oneUseNonce},
        ${requested.projectIdentity},
        ${requested.approvedActiveContentDigest ?? null},
        ${requested.approvedPolicyVersion ?? null},
        ${requested.idempotencyKey},
        ${requested.traceparent},
        ${requested.issuedAt},
        ${requested.expiresAt}
      )
      ON CONFLICT (buyer_id, device_key_thumbprint, idempotency_key)
      DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) {
      return { record: mapRow(inserted[0]), status: 'created' };
    }
    const existing = await this.#database<AuthorizationRow[]>`
      SELECT *
      FROM package_operation_authorizations
      WHERE buyer_id = ${requested.buyerId}
        AND device_key_thumbprint = ${requested.deviceKeyThumbprint}
        AND idempotency_key = ${requested.idempotencyKey}
      LIMIT 1
    `;
    const persisted = existing[0] ? mapRow(existing[0]) : undefined;
    if (!persisted) {
      throw new Error('package operation authorization reservation was lost');
    }
    if (!recordsMatch(persisted, requested)) {
      return { record: persisted, status: 'conflict' };
    }
    return {
      record: persisted,
      status: persisted.consumedAt ? 'consumed' : 'existing',
    };
  }

  async beginExchange(input: {
    buyerId: string;
    capabilityId: string;
    deviceKeyThumbprint: string;
    leaseMilliseconds?: number;
    tokenSha256: string;
  }): Promise<PackageOperationExchangeClaim> {
    requireText(input.buyerId, 'buyerId');
    if (!CAPABILITY_ID_PATTERN.test(input.capabilityId)) {
      throw new Error('capabilityId is invalid');
    }
    requireDigest(input.deviceKeyThumbprint, 'deviceKeyThumbprint');
    requireDigest(input.tokenSha256, 'tokenSha256');
    const leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
    if (
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1_000 ||
      leaseMilliseconds > 60_000
    ) {
      throw new Error('exchange lease duration is invalid');
    }
    return this.#database.begin(async (transaction) => {
      const claimed = await transaction<Array<{ exchange_generation: number }>>`
        UPDATE package_operation_authorizations
        SET
          consumed_at = COALESCE(consumed_at, clock_timestamp()),
          exchange_state = 'PROCESSING',
          exchange_generation = exchange_generation + 1,
          exchange_lease_until =
            clock_timestamp() + (${leaseMilliseconds} * interval '1 millisecond'),
          exchange_completed_at = NULL
        WHERE capability_id = ${input.capabilityId}
          AND buyer_id = ${input.buyerId}
          AND device_key_thumbprint = ${input.deviceKeyThumbprint}
          AND token_sha256 = ${input.tokenSha256}
          AND expires_at > clock_timestamp()
          AND (
            exchange_state = 'AVAILABLE'
            OR (
              exchange_state = 'PROCESSING'
              AND exchange_lease_until <= clock_timestamp()
            )
          )
        RETURNING exchange_generation
      `;
      if (claimed[0]) {
        return { generation: claimed[0].exchange_generation, status: 'claimed' };
      }
      const existing = await transaction<
        Array<{
          exchange_state: 'AVAILABLE' | 'PROCESSING' | 'READY';
          outcome_delivery_grant_id: string | null;
          outcome_grant_expires_at: Date | null;
          outcome_grant_issued_at: Date | null;
          outcome_grant_token_sha256: string | null;
          outcome_materialization_job_id: string | null;
          outcome_session_id: string | null;
          outcome_version_id: string | null;
          session_renewable_until: Date | null;
        }>
      >`
        SELECT
          exchange_state,
          outcome_delivery_grant_id,
          outcome_grant_expires_at,
          outcome_grant_issued_at,
          outcome_grant_token_sha256,
          outcome_materialization_job_id,
          outcome_session_id,
          outcome_version_id,
          session_renewable_until
        FROM package_operation_authorizations
        WHERE capability_id = ${input.capabilityId}
          AND buyer_id = ${input.buyerId}
          AND device_key_thumbprint = ${input.deviceKeyThumbprint}
          AND token_sha256 = ${input.tokenSha256}
          AND expires_at > clock_timestamp()
        LIMIT 1
      `;
      const row = existing[0];
      if (!row) {
        return { status: 'invalid' };
      }
      if (row.exchange_state === 'PROCESSING') {
        return { status: 'in_progress' };
      }
      if (
        row.exchange_state === 'READY' &&
        row.outcome_delivery_grant_id &&
        row.outcome_grant_expires_at &&
        row.outcome_grant_issued_at &&
        row.outcome_grant_token_sha256 &&
        row.outcome_session_id &&
        row.outcome_version_id &&
        row.session_renewable_until
      ) {
        return {
          deliveryGrantId: row.outcome_delivery_grant_id,
          grantExpiresAt: row.outcome_grant_expires_at,
          grantIssuedAt: row.outcome_grant_issued_at,
          grantTokenSha256: row.outcome_grant_token_sha256,
          ...(row.outcome_materialization_job_id
            ? { materializationJobId: row.outcome_materialization_job_id }
            : {}),
          renewableUntil: row.session_renewable_until,
          sessionId: row.outcome_session_id,
          status: 'ready',
          versionId: row.outcome_version_id,
        };
      }
      return { status: 'invalid' };
    });
  }

  async completeExchange(input: {
    capabilityId: string;
    deliveryGrantId: string;
    generation: number;
    grantExpiresAt: Date;
    grantIssuedAt: Date;
    grantTokenSha256: string;
    materializationJobId?: string;
    renewableUntil: Date;
    sessionId: string;
    versionId: string;
  }): Promise<boolean> {
    const grantLifetime = input.grantExpiresAt.getTime() - input.grantIssuedAt.getTime();
    const operationLifetime = input.renewableUntil.getTime() - input.grantIssuedAt.getTime();
    if (
      !Number.isFinite(input.grantIssuedAt.getTime()) ||
      !Number.isFinite(input.grantExpiresAt.getTime()) ||
      !Number.isFinite(input.renewableUntil.getTime()) ||
      grantLifetime <= 0 ||
      grantLifetime > PACKAGE_INSTALL_AUTHORIZATION_POLICY.grantLifetimeSeconds * 1_000 ||
      operationLifetime <= 0 ||
      operationLifetime > PACKAGE_INSTALL_AUTHORIZATION_POLICY.operationLifetimeSeconds * 1_000 ||
      input.grantExpiresAt > input.renewableUntil
    ) {
      throw new Error('install operation renewal lifetime is invalid');
    }
    const completed = await this.#database<Array<{ capability_id: string }>>`
      UPDATE package_operation_authorizations
      SET
        exchange_state = 'READY',
        exchange_lease_until = NULL,
        exchange_completed_at = clock_timestamp(),
        outcome_session_id = ${requireText(input.sessionId, 'sessionId')},
        outcome_delivery_grant_id =
          ${requireText(input.deliveryGrantId, 'deliveryGrantId')},
        outcome_grant_issued_at = ${input.grantIssuedAt},
        outcome_grant_expires_at = ${input.grantExpiresAt},
        outcome_grant_token_sha256 =
          ${requireDigest(input.grantTokenSha256, 'grantTokenSha256')},
        outcome_materialization_job_id = ${
          input.materializationJobId
            ? requireText(input.materializationJobId, 'materializationJobId')
            : null
        },
        outcome_version_id = ${requireText(input.versionId, 'versionId')},
        session_renewable_until = ${input.renewableUntil}
      WHERE capability_id = ${input.capabilityId}
        AND exchange_state = 'PROCESSING'
        AND exchange_generation = ${input.generation}
        AND exchange_lease_until > clock_timestamp()
      RETURNING capability_id
    `;
    return completed.length === 1;
  }

  async beginRenewal(input: {
    buyerId: string;
    deviceKeyThumbprint: string;
    grantTokenSha256: string;
    leaseMilliseconds?: number;
    sessionId: string;
    traceId: string;
  }): Promise<PackageOperationRenewalClaim> {
    requireText(input.buyerId, 'buyerId');
    requireDigest(input.deviceKeyThumbprint, 'deviceKeyThumbprint');
    requireDigest(input.grantTokenSha256, 'grantTokenSha256');
    requireText(input.sessionId, 'sessionId');
    if (!/^[0-9a-f]{32}$/.test(input.traceId) || input.traceId === '0'.repeat(32)) {
      throw new Error('traceId is invalid');
    }
    const leaseMilliseconds =
      input.leaseMilliseconds ?? PACKAGE_INSTALL_AUTHORIZATION_POLICY.renewalLeaseMilliseconds;
    if (
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1_000 ||
      leaseMilliseconds > 60_000
    ) {
      throw new Error('renewal lease duration is invalid');
    }
    type RenewalRow = {
      capability_id: string;
      current_grant_expired: boolean;
      outcome_delivery_grant_id: string | null;
      outcome_grant_expires_at: Date | null;
      outcome_grant_issued_at: Date | null;
      outcome_grant_token_sha256: string | null;
      previous_grant_token_sha256: string | null;
      policy_expired: boolean;
      renewal_generation: number;
      renewal_lease_expired: boolean;
      renewal_state: 'PROCESSING' | 'READY';
      session_renewable_until: Date | null;
    };
    const findRenewal = async (): Promise<RenewalRow | undefined> => {
      const rows = await this.#database<RenewalRow[]>`
        SELECT
          capability_id,
          outcome_delivery_grant_id,
          outcome_grant_expires_at,
          outcome_grant_issued_at,
          outcome_grant_token_sha256,
          previous_grant_token_sha256,
          session_renewable_until <=
            clock_timestamp() + interval '1 second' AS policy_expired,
          renewal_generation,
          COALESCE(renewal_lease_until <= clock_timestamp(), false) AS renewal_lease_expired,
          renewal_state,
          session_renewable_until,
          outcome_grant_expires_at <= clock_timestamp() AS current_grant_expired
        FROM package_operation_authorizations
        WHERE buyer_id = ${input.buyerId}
          AND device_key_thumbprint = ${input.deviceKeyThumbprint}
          AND outcome_session_id = ${input.sessionId}
          AND substring(traceparent FROM 4 FOR 32) = ${input.traceId}
          AND exchange_state = 'READY'
        LIMIT 1
      `;
      return rows[0];
    };
    const mapExisting = (
      row: RenewalRow | undefined
    ): Exclude<PackageOperationRenewalClaim, { status: 'claimed' }> | undefined => {
      if (!row) {
        return { status: 'invalid' };
      }
      if (
        row.policy_expired &&
        (row.outcome_grant_token_sha256 === input.grantTokenSha256 ||
          row.previous_grant_token_sha256 === input.grantTokenSha256)
      ) {
        return { status: 'expired' };
      }
      if (
        row.renewal_state === 'PROCESSING' &&
        !row.renewal_lease_expired &&
        (row.outcome_grant_token_sha256 === input.grantTokenSha256 ||
          row.previous_grant_token_sha256 === input.grantTokenSha256)
      ) {
        return { status: 'in_progress' };
      }
      if (
        row.renewal_state === 'READY' &&
        !row.current_grant_expired &&
        row.previous_grant_token_sha256 === input.grantTokenSha256 &&
        row.outcome_delivery_grant_id &&
        row.outcome_grant_expires_at &&
        row.outcome_grant_issued_at &&
        row.outcome_grant_token_sha256 &&
        row.session_renewable_until
      ) {
        return {
          capabilityId: row.capability_id,
          expiresAt: row.outcome_grant_expires_at,
          generation: row.renewal_generation,
          grantId: row.outcome_delivery_grant_id,
          grantTokenSha256: row.outcome_grant_token_sha256,
          issuedAt: row.outcome_grant_issued_at,
          renewableUntil: row.session_renewable_until,
          status: 'ready',
        };
      }
      if (
        row.renewal_state === 'READY' &&
        row.outcome_grant_token_sha256 !== input.grantTokenSha256 &&
        !(row.current_grant_expired && row.previous_grant_token_sha256 === input.grantTokenSha256)
      ) {
        return { status: 'invalid' };
      }
      return undefined;
    };
    const beforeClaim = mapExisting(await findRenewal());
    if (beforeClaim) {
      return beforeClaim;
    }
    const claimed = await this.#database<
      Array<{
        capability_id: string;
        outcome_delivery_grant_id: string;
        renewal_generation: number;
        renewal_issued_at: Date;
        session_renewable_until: Date;
      }>
    >`
        UPDATE package_operation_authorizations
        SET
          previous_grant_token_sha256 = ${input.grantTokenSha256},
          renewal_generation = renewal_generation + 1,
          renewal_issued_at = date_trunc('second', clock_timestamp()),
          renewal_lease_until =
            clock_timestamp() + (${leaseMilliseconds} * interval '1 millisecond'),
          renewal_state = 'PROCESSING'
        WHERE buyer_id = ${input.buyerId}
          AND device_key_thumbprint = ${input.deviceKeyThumbprint}
          AND outcome_session_id = ${input.sessionId}
          AND substring(traceparent FROM 4 FOR 32) = ${input.traceId}
          AND (
            outcome_grant_token_sha256 = ${input.grantTokenSha256}
            OR (
              previous_grant_token_sha256 = ${input.grantTokenSha256}
              AND outcome_grant_expires_at <= clock_timestamp()
            )
          )
          AND exchange_state = 'READY'
          AND session_renewable_until > clock_timestamp() + interval '1 second'
          AND (
            renewal_state = 'READY'
            OR (
              renewal_state = 'PROCESSING'
              AND renewal_lease_until <= clock_timestamp()
            )
          )
        RETURNING
          capability_id,
          outcome_delivery_grant_id,
          renewal_generation,
          renewal_issued_at,
          session_renewable_until
      `;
    if (claimed[0]) {
      return {
        capabilityId: claimed[0].capability_id,
        generation: claimed[0].renewal_generation,
        grantId: claimed[0].outcome_delivery_grant_id,
        issuedAt: claimed[0].renewal_issued_at,
        renewableUntil: claimed[0].session_renewable_until,
        status: 'claimed',
      };
    }
    return mapExisting(await findRenewal()) ?? { status: 'invalid' };
  }

  async completeRenewal(input: {
    capabilityId: string;
    generation: number;
    grantId: string;
    expiresAt: Date;
    grantTokenSha256: string;
    issuedAt: Date;
  }): Promise<boolean> {
    const lifetime = input.expiresAt.getTime() - input.issuedAt.getTime();
    if (
      !Number.isFinite(input.issuedAt.getTime()) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      lifetime <= 0 ||
      lifetime > PACKAGE_INSTALL_AUTHORIZATION_POLICY.grantLifetimeSeconds * 1_000
    ) {
      throw new Error('renewed grant lifetime is invalid');
    }
    const completed = await this.#database<Array<{ capability_id: string }>>`
      UPDATE package_operation_authorizations
      SET
        outcome_grant_issued_at = ${input.issuedAt},
        outcome_grant_expires_at = ${input.expiresAt},
        outcome_grant_token_sha256 =
          ${requireDigest(input.grantTokenSha256, 'grantTokenSha256')},
        renewal_lease_until = NULL,
        renewal_state = 'READY'
      WHERE capability_id = ${input.capabilityId}
        AND exchange_state = 'READY'
        AND outcome_delivery_grant_id = ${requireText(input.grantId, 'grantId')}
        AND renewal_generation = ${input.generation}
        AND renewal_state = 'PROCESSING'
        AND renewal_lease_until > clock_timestamp()
        AND renewal_issued_at = ${input.issuedAt}
        AND session_renewable_until >= ${input.expiresAt}
      RETURNING capability_id
    `;
    return completed.length === 1;
  }

  async releaseRenewal(input: { capabilityId: string; generation: number }): Promise<boolean> {
    const released = await this.#database<Array<{ capability_id: string }>>`
      UPDATE package_operation_authorizations
      SET
        previous_grant_token_sha256 = NULL,
        renewal_issued_at = NULL,
        renewal_lease_until = NULL,
        renewal_state = 'READY'
      WHERE capability_id = ${input.capabilityId}
        AND renewal_generation = ${input.generation}
        AND renewal_state = 'PROCESSING'
      RETURNING capability_id
    `;
    return released.length === 1;
  }

  async releaseExchange(input: { capabilityId: string; generation: number }): Promise<boolean> {
    const released = await this.#database<Array<{ capability_id: string }>>`
      UPDATE package_operation_authorizations
      SET
        exchange_state = 'AVAILABLE',
        exchange_lease_until = NULL
      WHERE capability_id = ${input.capabilityId}
        AND exchange_state = 'PROCESSING'
        AND exchange_generation = ${input.generation}
      RETURNING capability_id
    `;
    return released.length === 1;
  }

  dpopReplayStore(): {
    reserve(reservation: { expiresAt: Date; key: string; now: Date }): Promise<boolean>;
  } {
    return {
      reserve: async (reservation) => {
        const lifetime = reservation.expiresAt.getTime() - reservation.now.getTime();
        if (
          !Number.isFinite(reservation.now.getTime()) ||
          !Number.isFinite(reservation.expiresAt.getTime()) ||
          lifetime <= 0 ||
          lifetime > PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS
        ) {
          return false;
        }
        const replayKey = createHash('sha256')
          .update('yucp:package-install-dpop-replay:v1\0', 'utf8')
          .update(reservation.key, 'utf8')
          .digest('hex');
        return this.#database.begin(async (transaction) => {
          await transaction`
            DELETE FROM package_install_dpop_replays
            WHERE ctid IN (
              SELECT ctid
              FROM package_install_dpop_replays
              WHERE expires_at <= ${reservation.now}
              ORDER BY expires_at
              LIMIT 100
            )
          `;
          const inserted = await transaction<{ replay_key: string }[]>`
            INSERT INTO package_install_dpop_replays (replay_key, expires_at)
            VALUES (${replayKey}, ${reservation.expiresAt})
            ON CONFLICT (replay_key) DO NOTHING
            RETURNING replay_key
          `;
          return inserted.length === 1;
        });
      },
    };
  }
}
