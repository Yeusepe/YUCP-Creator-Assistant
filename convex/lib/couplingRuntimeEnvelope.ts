import { deriveEnvelopeKeyBytes } from './releaseArtifactEnvelope';

export type CouplingRuntimeEnvelopeInput = {
  artifactKey: string;
  channel: string;
  platform: string;
  version: string;
  plaintextSha256: string;
};

export function getCouplingRuntimeEnvelopeSecret(): string {
  const secret = process.env.YUCP_RELEASE_ENVELOPE_KEY?.trim();
  if (!secret) {
    throw new Error(
      'YUCP_RELEASE_ENVELOPE_KEY is required for runtime artifact envelope derivation'
    );
  }
  return secret;
}

export function buildCouplingRuntimeEnvelopePurpose(args: CouplingRuntimeEnvelopeInput): string {
  return [
    'signed-release-artifact',
    args.artifactKey,
    args.channel,
    args.platform,
    args.version,
    args.plaintextSha256,
  ].join('|');
}

export async function deriveCouplingRuntimeEnvelopeKeyBytes(
  args: CouplingRuntimeEnvelopeInput
): Promise<Uint8Array> {
  const envelopeSecret = getCouplingRuntimeEnvelopeSecret();

  return await deriveEnvelopeKeyBytes(envelopeSecret, buildCouplingRuntimeEnvelopePurpose(args));
}
