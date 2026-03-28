import {
  base64ToBytes,
  bytesToBase64,
  decryptArtifactEnvelope,
  deriveEnvelopeKeyBytes,
  encryptArtifactEnvelope,
} from './releaseArtifactEnvelope';

const PROTECTED_MATERIALIZATION_GRANT_PURPOSE = 'yucp-protected-materialization-grant-v1';
const ENVELOPE_VERSION = 1;

type ProtectedMaterializationGrantEnvelope = {
  v: number;
  ivBase64: string;
  ciphertextBase64: string;
};

export type ProtectedMaterializationGrantPayload = {
  schemaVersion: 1;
  grantId: string;
  creatorAuthUserId: string;
  packageId: string;
  protectedAssetId: string;
  licenseSubject: string;
  machineFingerprint: string;
  projectId: string;
  issuedAt: number;
  expiresAt: number;
  unlockToken: string;
  unlockExpiresAt: number;
  coupling: {
    subject?: string;
    skipReason?: string;
    jobs: Array<{
      assetPath: string;
      tokenHex: string;
      /** 16 hex chars (8-byte CSPRNG). Required in v2 grants; absent in legacy v1 grants. */
      materializationNonce?: string;
    }>;
    /** Convex storage ID for the pack blob associated with this grant.
     *  Populated once pack delivery is implemented (Phase 4+). */
    packBlobId?: string;
  };
};

function getGrantSecret(): string {
  const secret = process.env.YUCP_GRANT_SEAL_KEY;
  if (!secret) {
    throw new Error('YUCP_GRANT_SEAL_KEY is required for protected materialization grants');
  }
  return secret;
}

function parseGrantEnvelope(input: string): ProtectedMaterializationGrantEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(input)));
  } catch {
    throw new Error('Protected materialization grant is not valid base64 JSON');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== ENVELOPE_VERSION ||
    typeof (parsed as { ivBase64?: unknown }).ivBase64 !== 'string' ||
    typeof (parsed as { ciphertextBase64?: unknown }).ciphertextBase64 !== 'string'
  ) {
    throw new Error('Protected materialization grant envelope is invalid');
  }

  return parsed as ProtectedMaterializationGrantEnvelope;
}

function parseGrantPayload(input: string): ProtectedMaterializationGrantPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Protected materialization grant payload is not valid JSON');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { grantId?: unknown }).grantId !== 'string' ||
    typeof (parsed as { creatorAuthUserId?: unknown }).creatorAuthUserId !== 'string' ||
    typeof (parsed as { packageId?: unknown }).packageId !== 'string' ||
    typeof (parsed as { protectedAssetId?: unknown }).protectedAssetId !== 'string' ||
    typeof (parsed as { licenseSubject?: unknown }).licenseSubject !== 'string' ||
    typeof (parsed as { machineFingerprint?: unknown }).machineFingerprint !== 'string' ||
    typeof (parsed as { projectId?: unknown }).projectId !== 'string' ||
    typeof (parsed as { issuedAt?: unknown }).issuedAt !== 'number' ||
    typeof (parsed as { expiresAt?: unknown }).expiresAt !== 'number' ||
    typeof (parsed as { unlockToken?: unknown }).unlockToken !== 'string' ||
    typeof (parsed as { unlockExpiresAt?: unknown }).unlockExpiresAt !== 'number' ||
    !('coupling' in parsed)
  ) {
    throw new Error('Protected materialization grant payload is invalid');
  }

  return parsed as ProtectedMaterializationGrantPayload;
}

export async function sealProtectedMaterializationGrant(
  payload: ProtectedMaterializationGrantPayload
): Promise<string> {
  const secret = getGrantSecret();
  const keyBytes = await deriveEnvelopeKeyBytes(secret, PROTECTED_MATERIALIZATION_GRANT_PURPOSE);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await encryptArtifactEnvelope(plaintext, keyBytes);
  const envelope: ProtectedMaterializationGrantEnvelope = {
    v: ENVELOPE_VERSION,
    ivBase64: encrypted.ivBase64,
    ciphertextBase64: bytesToBase64(encrypted.ciphertext),
  };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}

export async function unsealProtectedMaterializationGrant(
  grant: string
): Promise<ProtectedMaterializationGrantPayload> {
  const envelope = parseGrantEnvelope(grant);
  const secret = getGrantSecret();
  const keyBytes = await deriveEnvelopeKeyBytes(secret, PROTECTED_MATERIALIZATION_GRANT_PURPOSE);
  const plaintext = await decryptArtifactEnvelope(
    base64ToBytes(envelope.ciphertextBase64),
    keyBytes,
    envelope.ivBase64
  );
  return parseGrantPayload(new TextDecoder().decode(plaintext));
}
