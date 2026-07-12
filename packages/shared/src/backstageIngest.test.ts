import { describe, expect, it } from 'bun:test';

import { parseIngestResult, sign, verify } from './backstageIngest';

const SECRET = '11'.repeat(32);
const WRONG_SECRET = '22'.repeat(32);

function futurePayload() {
  return {
    typ: 'backstage-upload',
    authUserId: 'auth-user-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

function validIngestResult() {
  return {
    typ: 'backstage-ingest-result' as const,
    authUserId: 'auth-user-1',
    packageId: 'com.yucp.example',
    version: '1.2.3',
    loreSource: {
      repositoryId: '1'.repeat(32),
      address: `${'2'.repeat(64)}-${'3'.repeat(32)}`,
      sha256: '4'.repeat(64),
      byteSize: 1234,
      uploadedAt: '2026-07-11T12:00:00.000Z',
      tenantId: 'auth-user-1',
    },
    loreDelivery: {
      repositoryId: '1'.repeat(32),
      address: `${'5'.repeat(64)}-${'6'.repeat(32)}`,
      sha256: '7'.repeat(64),
      byteSize: 2345,
      uploadedAt: '2026-07-11T12:01:00.000Z',
      tenantId: 'auth-user-1',
    },
    rawSha256: '4'.repeat(64),
    rawByteSize: 1234,
    rawDeliveryName: 'example.unitypackage',
    rawContentType: 'application/octet-stream',
    deliverableSha256: '7'.repeat(64),
    deliverableByteSize: 2345,
    deliverableDeliveryName: 'com.yucp.example.zip',
    deliverableContentType: 'application/zip',
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

describe('backstage ingest signing', () => {
  it('round-trips a signed payload and preserves its type', async () => {
    const payload = futurePayload();

    const verified = await verify<typeof payload>(SECRET, await sign(SECRET, payload));

    expect(verified).toEqual(payload);
    expect(verified.typ).toBe('backstage-upload');
  });

  it('rejects a tampered payload', async () => {
    const token = await sign(SECRET, futurePayload());
    const [encodedPayload, encodedSignature] = token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ ...futurePayload(), authUserId: 'attacker' }))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    await expect(verify(SECRET, `${tamperedPayload}.${encodedSignature}`)).rejects.toThrow(
      'signature'
    );
    expect(encodedPayload).not.toBe(tamperedPayload);
  });

  it('rejects an expired token', async () => {
    const token = await sign(SECRET, {
      ...futurePayload(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verify(SECRET, token)).rejects.toThrow('expired');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await sign(SECRET, futurePayload());

    await expect(verify(WRONG_SECRET, token)).rejects.toThrow('signature');
  });
});

describe('parseIngestResult', () => {
  it('accepts a complete signed-result payload', () => {
    const result = validIngestResult();

    expect(parseIngestResult(result)).toEqual(result);
  });

  it('rejects bundle metadata that does not match the Lore artifact references', () => {
    expect(() => parseIngestResult({ ...validIngestResult(), rawSha256: '8'.repeat(64) })).toThrow(
      'loreSource'
    );
    expect(() => parseIngestResult({ ...validIngestResult(), rawByteSize: 1235 })).toThrow(
      'loreSource'
    );
    expect(() =>
      parseIngestResult({ ...validIngestResult(), deliverableSha256: '9'.repeat(64) })
    ).toThrow('loreDelivery');
    expect(() => parseIngestResult({ ...validIngestResult(), deliverableByteSize: 2346 })).toThrow(
      'loreDelivery'
    );
  });

  it('rejects the wrong result type and malformed artifact references', () => {
    expect(() => parseIngestResult({ ...validIngestResult(), typ: 'backstage-upload' })).toThrow(
      'typ'
    );
    expect(() =>
      parseIngestResult({
        ...validIngestResult(),
        loreDelivery: { ...validIngestResult().loreDelivery, byteSize: '2345' },
      })
    ).toThrow('loreDelivery');
  });

  it('rejects malformed digest, byte-size, string, and expiration fields', () => {
    expect(() => parseIngestResult({ ...validIngestResult(), rawSha256: 'not-a-digest' })).toThrow(
      'rawSha256'
    );
    expect(() => parseIngestResult({ ...validIngestResult(), rawByteSize: -1 })).toThrow(
      'rawByteSize'
    );
    expect(() => parseIngestResult({ ...validIngestResult(), rawDeliveryName: '' })).toThrow(
      'rawDeliveryName'
    );
    expect(() => parseIngestResult({ ...validIngestResult(), exp: 0 })).toThrow('exp');
  });
});
