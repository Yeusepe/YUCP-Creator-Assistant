import * as ed from '@noble/ed25519';
import { base64ToBytes } from './yucpCrypto';

export interface SigningProofPayload {
  certNonce: string;
  packageId: string;
  contentHash: string;
  packageVersion?: string;
  requestNonce: string;
  requestTimestamp: number;
}

export const SIGNING_REQUEST_MAX_SKEW_MS = 5 * 60 * 1000;

export function buildSigningProofPayload(input: SigningProofPayload): string {
  return [
    'yucp-signature-proof-v1',
    input.certNonce,
    input.packageId,
    input.contentHash,
    input.packageVersion ?? '',
    input.requestNonce,
    String(input.requestTimestamp),
  ].join('\n');
}

export function isSigningRequestTimestampFresh(
  requestTimestamp: number,
  now = Date.now()
): boolean {
  return (
    Number.isFinite(requestTimestamp) &&
    Math.abs(now - requestTimestamp) <= SIGNING_REQUEST_MAX_SKEW_MS
  );
}

export async function verifySigningProof(
  input: SigningProofPayload,
  requestSignatureBase64: string,
  devPublicKeyBase64: string
): Promise<boolean> {
  try {
    const payloadBytes = new TextEncoder().encode(buildSigningProofPayload(input));
    const signatureBytes = base64ToBytes(requestSignatureBase64);
    const publicKeyBytes = base64ToBytes(devPublicKeyBase64);
    return await ed.verifyAsync(signatureBytes, payloadBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
