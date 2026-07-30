import * as ed25519 from '@noble/ed25519';
import {
  type UnsignedYucpBootstrapIntent,
  type YucpBootstrapIntent,
  yucpBootstrapIntentSigningPayload,
} from '@yucp/shared';

export interface BootstrapIntentSigningConfig {
  keyId: string;
  privateKey: Uint8Array;
}

export async function signYucpBootstrapIntent(input: {
  aliasId: string;
  config: BootstrapIntentSigningConfig;
  intent: Omit<UnsignedYucpBootstrapIntent, 'keyId'>;
}): Promise<YucpBootstrapIntent> {
  if (input.config.privateKey.byteLength !== 32) {
    throw new Error('Bootstrap intent private key must be a 32-byte Ed25519 seed');
  }
  const unsigned: UnsignedYucpBootstrapIntent = {
    ...input.intent,
    keyId: input.config.keyId,
  };
  const signature = await ed25519.signAsync(
    yucpBootstrapIntentSigningPayload({
      aliasId: input.aliasId,
      intent: unsigned,
    }),
    input.config.privateKey
  );
  return {
    ...unsigned,
    signature: Buffer.from(signature).toString('base64url'),
  };
}

export async function verifyYucpBootstrapIntent(input: {
  aliasId: string;
  intent: YucpBootstrapIntent;
  publicKey: Uint8Array;
}): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(input.intent.signature, 'base64url'));
    if (
      signature.byteLength !== 64 ||
      Buffer.from(signature).toString('base64url') !== input.intent.signature
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const { signature: _signature, ...unsigned } = input.intent;
  return ed25519.verifyAsync(
    signature,
    yucpBootstrapIntentSigningPayload({
      aliasId: input.aliasId,
      intent: unsigned,
    }),
    input.publicKey
  );
}
