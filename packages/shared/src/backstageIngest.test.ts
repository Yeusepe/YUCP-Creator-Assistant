import { describe, expect, it } from 'bun:test';

import {
  parseMaterializeClaims,
  parseMaterializePollClaims,
  parseMaterializeResult,
  parseUploadClaims,
  parseUploadResult,
  sign,
  verify,
} from './backstageIngest';

const SECRET = '11'.repeat(32);
const WRONG_SECRET = '22'.repeat(32);

function futurePayload() {
  return {
    typ: 'backstage-upload',
    authUserId: 'auth-user-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

function validUploadClaims() {
  return {
    typ: 'backstage-upload' as const,
    authUserId: 'auth-user-1',
    packageId: 'com.yucp.example',
    version: '1.2.3',
    repositoryId: '1'.repeat(32),
    deliveryName: 'example.unitypackage',
    sourceContentType: 'application/octet-stream',
    declaredSha256: '4'.repeat(64),
    byteSize: 1234,
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

function validUploadResult() {
  return {
    typ: 'backstage-upload-result' as const,
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
    rawSha256: '4'.repeat(64),
    rawByteSize: 1234,
    rawDeliveryName: 'example.unitypackage',
    rawContentType: 'application/octet-stream',
    sourceKind: 'unitypackage' as const,
    managedPaths: ['Assets/Example.prefab', 'Assets/Example.prefab.meta'],
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

function validMaterializeClaims() {
  const upload = validUploadResult();
  return {
    typ: 'backstage-materialize' as const,
    authUserId: upload.authUserId,
    packageId: upload.packageId,
    version: upload.version,
    repositoryId: upload.loreSource.repositoryId,
    loreSourceAddress: upload.loreSource.address,
    loreSourceSha256: upload.rawSha256,
    deliveryName: upload.rawDeliveryName,
    sourceContentType: upload.rawContentType,
    sourceKind: upload.sourceKind,
    managedPaths: upload.managedPaths,
    materializeMetadata: {
      displayName: 'Example Package',
      metadata: { yucp: { aliasId: 'alias-123' } },
    },
    exp: upload.exp,
  };
}

function validMaterializeResult() {
  const upload = validUploadResult();
  return {
    typ: 'backstage-materialize-result' as const,
    authUserId: upload.authUserId,
    packageId: upload.packageId,
    version: upload.version,
    loreDelivery: {
      repositoryId: '1'.repeat(32),
      address: `${'5'.repeat(64)}-${'6'.repeat(32)}`,
      sha256: '7'.repeat(64),
      byteSize: 2345,
      uploadedAt: '2026-07-11T12:01:00.000Z',
      tenantId: 'auth-user-1',
    },
    deliverableSha256: '7'.repeat(64),
    deliverableByteSize: 2345,
    deliverableDeliveryName: 'com.yucp.example.zip',
    deliverableContentType: 'application/zip',
    exp: upload.exp,
  };
}

function validMaterializePollClaims() {
  return {
    typ: 'backstage-materialize-poll' as const,
    authUserId: 'auth-user-1',
    packageId: 'com.yucp.example',
    version: '1.2.3',
    jobId: 'materialize-job-1',
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

  it('rejects an expired token by default', async () => {
    const token = await sign(SECRET, {
      ...futurePayload(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verify(SECRET, token)).rejects.toThrow('expired');
  });

  it('accepts an expired correctly signed token when expiry is ignored', async () => {
    const payload = {
      ...futurePayload(),
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    const token = await sign(SECRET, payload);

    await expect(verify<typeof payload>(SECRET, token, { ignoreExpiry: true })).resolves.toEqual(
      payload
    );
  });

  it('rejects a wrong signature when expiry is ignored', async () => {
    const token = await sign(WRONG_SECRET, {
      ...futurePayload(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verify(SECRET, token, { ignoreExpiry: true })).rejects.toThrow('signature');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await sign(SECRET, futurePayload());

    await expect(verify(WRONG_SECRET, token)).rejects.toThrow('signature');
  });
});

describe('parseUploadClaims', () => {
  it('keeps upload claims limited to upload invariants', () => {
    const claims = validUploadClaims();

    const parsed = parseUploadClaims({
      ...claims,
      materializeMetadata: {
        displayName: 'Example Package',
        metadata: { yucp: { aliasId: 'alias-123' } },
      },
    });

    expect(parsed).toEqual(claims);
    expect(parsed).not.toHaveProperty('materializeMetadata');
  });
});

describe('parseUploadResult', () => {
  it('accepts a raw-only upload result with safe managed paths', () => {
    const result = validUploadResult();

    expect(parseUploadResult(result)).toEqual(result);
  });

  it('rejects malformed source kinds and unsafe managed paths', () => {
    expect(() => parseUploadResult({ ...validUploadResult(), sourceKind: 'tar' })).toThrow(
      'sourceKind'
    );
    for (const managedPaths of [
      [],
      ['../escape'],
      ['/absolute'],
      ['Assets//empty'],
      ['Assets/./dot'],
      ['C:/absolute'],
      ['Assets\\backslash'],
      [''],
      [1],
      'Assets/not-an-array',
    ]) {
      expect(() => parseUploadResult({ ...validUploadResult(), managedPaths })).toThrow(
        'managedPaths'
      );
    }
  });

  it('rejects source metadata that does not match loreSource', () => {
    expect(() => parseUploadResult({ ...validUploadResult(), rawSha256: '8'.repeat(64) })).toThrow(
      'loreSource'
    );
    expect(() => parseUploadResult({ ...validUploadResult(), rawByteSize: 1235 })).toThrow(
      'loreSource'
    );
  });
});

describe('parseMaterializeClaims', () => {
  it('accepts fully resolved materialization claims', () => {
    const claims = validMaterializeClaims();

    expect(parseMaterializeClaims(claims)).toEqual(claims);
  });

  it('rejects malformed repository, digest, source kind, and metadata fields', () => {
    expect(() =>
      parseMaterializeClaims({ ...validMaterializeClaims(), repositoryId: 'ABC' })
    ).toThrow('repositoryId');
    expect(() =>
      parseMaterializeClaims({ ...validMaterializeClaims(), loreSourceSha256: 'bad' })
    ).toThrow('loreSourceSha256');
    expect(() =>
      parseMaterializeClaims({ ...validMaterializeClaims(), loreSourceAddress: 'bad' })
    ).toThrow('loreSourceAddress');
    expect(() =>
      parseMaterializeClaims({ ...validMaterializeClaims(), sourceKind: 'tar' })
    ).toThrow('sourceKind');
    for (const managedPaths of [
      [],
      ['../escape'],
      ['/absolute'],
      ['Assets//empty'],
      ['Assets/./dot'],
      ['C:/absolute'],
      ['Assets\\backslash'],
      [''],
      [1],
      'Assets/not-an-array',
    ]) {
      expect(() => parseMaterializeClaims({ ...validMaterializeClaims(), managedPaths })).toThrow(
        'managedPaths'
      );
    }
    expect(() =>
      parseMaterializeClaims({ ...validMaterializeClaims(), materializeMetadata: [] })
    ).toThrow('materializeMetadata');
    expect(() =>
      parseMaterializeClaims({
        ...validMaterializeClaims(),
        materializeMetadata: { metadata: [] },
      })
    ).toThrow('materializeMetadata.metadata');
  });
});

describe('parseMaterializePollClaims', () => {
  it('accepts a small materialization poll claim without release metadata', () => {
    const claims = validMaterializePollClaims();

    expect(parseMaterializePollClaims(claims)).toEqual(claims);
    expect(parseMaterializePollClaims(claims)).not.toHaveProperty('managedPaths');
    expect(parseMaterializePollClaims(claims)).not.toHaveProperty('materializeMetadata');
  });

  it('rejects malformed poll claim fields', () => {
    expect(() =>
      parseMaterializePollClaims({ ...validMaterializePollClaims(), typ: 'backstage-materialize' })
    ).toThrow('typ');
    expect(() =>
      parseMaterializePollClaims({ ...validMaterializePollClaims(), jobId: '' })
    ).toThrow('jobId');
    expect(() =>
      parseMaterializePollClaims({ ...validMaterializePollClaims(), managedPaths: ['large'] })
    ).toThrow('unexpected field managedPaths');
  });
});

describe('parseMaterializeResult', () => {
  it('accepts a deliverable-only materialization result', () => {
    const result = validMaterializeResult();

    expect(parseMaterializeResult(result)).toEqual(result);
  });

  it('rejects deliverable metadata that does not match loreDelivery', () => {
    expect(() =>
      parseMaterializeResult({ ...validMaterializeResult(), deliverableSha256: '9'.repeat(64) })
    ).toThrow('loreDelivery');
    expect(() =>
      parseMaterializeResult({ ...validMaterializeResult(), deliverableByteSize: 2346 })
    ).toThrow('loreDelivery');
  });
});
