import { describe, expect, it } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { normalizeBackstageRawPayload } from './backstageRawPayload';

describe('normalizeBackstageRawPayload', () => {
  it('unwraps backstage wrapper ZIPs even when they are mislabeled as application/octet-stream', () => {
    const payloadBytes = strToU8('unitypackage-bytes');
    const wrapperBytes = zipSync(
      {
        'BackstagePayload~/payload.unitypackage': payloadBytes,
        'BackstagePayload~/backstage-payload.json': strToU8(
          JSON.stringify({
            payloadFileName: 'payload.unitypackage',
          })
        ),
      },
      { level: 9 }
    );

    expect(
      normalizeBackstageRawPayload({
        sourceBytes: wrapperBytes,
        contentType: 'application/octet-stream',
        deliveryName: 'vrc-get-com.yucp.example-1.2.3.zip',
        packageId: 'com.yucp.example',
        version: '1.2.3',
      })
    ).toEqual({
      bytes: payloadBytes,
      contentType: 'application/octet-stream',
      deliveryName: 'payload.unitypackage',
      payloadSourceKind: 'legacy-wrapper',
    });
  });
});
