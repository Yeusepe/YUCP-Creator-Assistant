import { describe, expect, it } from 'bun:test';
import * as ed from '@noble/ed25519';
import {
  buildSigningProofPayload,
  isSigningRequestTimestampFresh,
  verifySigningProof,
} from './certificateSigning';

describe('certificateSigning', () => {
  it('builds a stable canonical signing proof payload', () => {
    expect(
      buildSigningProofPayload({
        certNonce: 'cert_nonce',
        packageId: 'com.yucp.demo',
        contentHash: 'deadbeef',
        packageVersion: '1.2.3',
        requestNonce: 'req_nonce',
        requestTimestamp: 1_700_000_000_000,
      })
    ).toBe(
      'yucp-signature-proof-v1\ncert_nonce\ncom.yucp.demo\ndeadbeef\n1.2.3\nreq_nonce\n1700000000000'
    );
  });

  it('verifies an Ed25519 signing proof', async () => {
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payload = {
      certNonce: 'cert_nonce',
      packageId: 'com.yucp.demo',
      contentHash: 'deadbeef',
      packageVersion: '1.2.3',
      requestNonce: 'req_nonce',
      requestTimestamp: Date.now(),
    };

    const signature = await ed.signAsync(
      new TextEncoder().encode(buildSigningProofPayload(payload)),
      privateKey
    );

    await expect(
      verifySigningProof(
        payload,
        Buffer.from(signature).toString('base64'),
        Buffer.from(publicKey).toString('base64')
      )
    ).resolves.toBe(true);
  });

  it('rejects stale timestamps', () => {
    expect(isSigningRequestTimestampFresh(Date.now() - 10 * 60 * 1000)).toBe(false);
  });
});
