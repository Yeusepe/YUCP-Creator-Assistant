import {
  type DeliveryGrantV2,
  encodeDeliveryGrantV2,
  encodeInstallSessionV2,
  INSTALL_SESSION_TOKEN_TYPE,
  type InstallSessionOperation,
  type InstallSessionV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
} from '../../../../ops/storage-core/packageContractsV2';
import { PACKAGE_INSTALL_AUTHORIZATION_POLICY } from '../../../../ops/storage-core/packageInstallAuthorizationPolicy';

export const INSTALL_SESSION_LIFETIME_SECONDS =
  PACKAGE_INSTALL_AUTHORIZATION_POLICY.grantLifetimeSeconds;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface PackageInstallPublication {
  activeContentDigest: string;
  activePolicyVersion: string;
  aliasId: string;
  bindingRoot: string;
  catalogProductIds: string[];
  commonRoot: string;
  creatorId: string;
  logicalBytes: number;
  logicalFiles: number;
  manifestSha256: string;
  packageId: string;
  protectedFiles: Array<{
    materializerType: string;
    normalizedPath: string;
    required: boolean;
    sourceSha256: string;
  }>;
  protectedSourceRoot: string;
  protectionPolicyDigest: string;
  protectionPolicyId: string;
  releaseRoot: string;
  version: string;
  versionId: string;
}

export interface IssuePackageInstallSessionInput {
  audience: string;
  buyerId: string;
  deliveryGrantId: string;
  deviceKeyThumbprint: string;
  expiresAt?: number;
  issuer: string;
  keyId: string;
  materializationJobId?: string;
  now: number;
  operation: InstallSessionOperation;
  privateKey: Uint8Array;
  publication: PackageInstallPublication;
  sessionId: string;
}

export interface IssuedPackageInstallSession {
  deliveryGrant: Uint8Array;
  deliveryGrantPurpose: typeof PACKAGE_CONTRACT_PURPOSES.deliveryGrant;
  installSession: Uint8Array;
  installSessionPurpose: typeof PACKAGE_CONTRACT_PURPOSES.installSession;
  materializationJobId?: string;
  deliveryGrantId: string;
  sessionId: string;
  versionId: string;
}

function requireDigest(value: string, name: string): Uint8Array {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 512) {
    throw new Error(`${name} must contain 1 through 512 UTF-8 bytes`);
  }
  return normalized;
}

function requireOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute origin`);
  }
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTPS or loopback HTTP origin`);
  }
  return parsed.origin;
}

function requirePublication(publication: PackageInstallPublication): PackageInstallPublication {
  const versionId = requireText(publication.versionId, 'publication.versionId');
  if (!SAFE_ID_PATTERN.test(versionId)) {
    throw new Error('publication.versionId must be a safe delivery identifier');
  }
  if (!Number.isSafeInteger(publication.logicalBytes) || publication.logicalBytes < 0) {
    throw new Error('publication.logicalBytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(publication.logicalFiles) || publication.logicalFiles <= 0) {
    throw new Error('publication.logicalFiles must be a positive safe integer');
  }
  if (
    publication.catalogProductIds.length === 0 ||
    publication.catalogProductIds.some((productId) => !productId.trim())
  ) {
    throw new Error('publication.catalogProductIds must contain at least one product identifier');
  }
  requireDigest(publication.releaseRoot, 'publication.releaseRoot');
  requireDigest(publication.bindingRoot, 'publication.bindingRoot');
  requireDigest(publication.manifestSha256, 'publication.manifestSha256');
  requireDigest(publication.commonRoot, 'publication.commonRoot');
  requireDigest(publication.protectedSourceRoot, 'publication.protectedSourceRoot');
  requireDigest(publication.protectionPolicyDigest, 'publication.protectionPolicyDigest');
  requireDigest(publication.activeContentDigest, 'publication.activeContentDigest');
  requireText(publication.activePolicyVersion, 'publication.activePolicyVersion');
  requireText(publication.aliasId, 'publication.aliasId');
  requireText(publication.creatorId, 'publication.creatorId');
  requireText(publication.packageId, 'publication.packageId');
  requireText(publication.protectionPolicyId, 'publication.protectionPolicyId');
  requireText(publication.version, 'publication.version');
  if (publication.protectedFiles.length > 512) {
    throw new Error('publication.protectedFiles exceeds the protected file limit');
  }
  return publication;
}

export async function issuePackageInstallSession(
  input: IssuePackageInstallSessionInput
): Promise<IssuedPackageInstallSession> {
  const publication = requirePublication(input.publication);
  const issuer = requireOrigin(input.issuer, 'issuer');
  const audience = requireOrigin(input.audience, 'audience');
  const buyerId = requireText(input.buyerId, 'buyerId');
  const keyId = requireText(input.keyId, 'keyId');
  const deliveryGrantId = requireText(input.deliveryGrantId, 'deliveryGrantId');
  const sessionId = requireText(input.sessionId, 'sessionId');
  if (!SAFE_ID_PATTERN.test(deliveryGrantId) || !SAFE_ID_PATTERN.test(sessionId)) {
    throw new Error('Install session identifiers must use safe delivery characters');
  }
  const hasProtectedFiles = publication.protectedFiles.length > 0;
  const requiresMaterialization = hasProtectedFiles && input.operation !== 'uninstall';
  const materializationJobId = input.materializationJobId
    ? requireText(input.materializationJobId, 'materializationJobId')
    : undefined;
  if (
    requiresMaterialization !== Boolean(materializationJobId) ||
    (materializationJobId && !SAFE_ID_PATTERN.test(materializationJobId))
  ) {
    throw new Error('materializationJobId must match the lifecycle operation and publication');
  }
  const keyIdBytes = packageContractKeyId(keyId);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('now must be a non-negative Unix timestamp in seconds');
  }
  if (input.privateKey.byteLength !== 32) {
    throw new Error('privateKey must be a 32-byte Ed25519 private key');
  }

  const releaseRoot = requireDigest(publication.releaseRoot, 'publication.releaseRoot');
  const bindingRoot = requireDigest(publication.bindingRoot, 'publication.bindingRoot');
  const deviceKeyThumbprint = requireDigest(input.deviceKeyThumbprint, 'deviceKeyThumbprint');
  const manifestSha256 = requireDigest(publication.manifestSha256, 'publication.manifestSha256');
  const expiresAt = input.expiresAt ?? input.now + INSTALL_SESSION_LIFETIME_SECONDS;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= input.now ||
    expiresAt > input.now + INSTALL_SESSION_LIFETIME_SECONDS
  ) {
    throw new Error('expiresAt must remain inside the install session lifetime policy');
  }
  const session: InstallSessionV2 = {
    aliasId: publication.aliasId,
    allowedApiOrigins: [issuer],
    allowedArtifactOrigins: [audience],
    audience,
    bindingRoot,
    bootstrap: [
      {
        kind: 'logical-tree-manifest-v4',
        sha256: manifestSha256,
        url: `${audience}/v2/delivery/${encodeURIComponent(publication.versionId)}/manifest`,
      },
    ],
    buyerId,
    creatorId: publication.creatorId,
    deviceKeyThumbprint,
    expiresAt,
    issuedAt: input.now,
    issuer,
    keyId,
    maxLifetimeSeconds: INSTALL_SESSION_LIFETIME_SECONDS,
    notBefore: input.now,
    operation: input.operation,
    productId: publication.packageId,
    releaseRoot,
    sessionId,
    tokenType: INSTALL_SESSION_TOKEN_TYPE,
    version: publication.version,
  };
  const grant: DeliveryGrantV2 = {
    audience,
    bindingRoot,
    buyerId,
    creatorId: publication.creatorId,
    deviceKeyThumbprint,
    expiresAt,
    grantId: deliveryGrantId,
    installSessionId: sessionId,
    issuedAt: input.now,
    issuer,
    notBefore: input.now,
    productId: publication.packageId,
    releaseRoot,
    scopes: [
      ...(materializationJobId ? [`materialization:${materializationJobId}:read`] : []),
      `package:${publication.versionId}:${input.operation === 'uninstall' ? 'uninstall' : 'read'}`,
    ].sort((left, right) => left.localeCompare(right)),
  };

  const [signedSession, signedGrant] = await Promise.all([
    signPackageContract({
      keyId: keyIdBytes,
      payload: encodeInstallSessionV2(session),
      privateKey: input.privateKey,
      purpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    }),
    signPackageContract({
      keyId: keyIdBytes,
      payload: encodeDeliveryGrantV2(grant),
      privateKey: input.privateKey,
      purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
    }),
  ]);

  return {
    deliveryGrantId,
    deliveryGrant: signedGrant.coseSign1,
    deliveryGrantPurpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
    installSession: signedSession.coseSign1,
    installSessionPurpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    ...(materializationJobId ? { materializationJobId } : {}),
    sessionId,
    versionId: publication.versionId,
  };
}
