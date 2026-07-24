import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { verifyRenditionReadback } from './renditionVerifier';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('trusted rendition readback', () => {
  test('verifies the exact object and every declared personalized output', async () => {
    const protectedBytes = new TextEncoder().encode('personalized output');
    const archive = zipSync({
      'Assets/Product/common.txt': new TextEncoder().encode('common'),
      'Assets/Product/protected.png': protectedBytes,
    });

    const result = await verifyRenditionReadback({
      expectedBytes: archive.byteLength,
      expectedObjectSha256: sha256(archive),
      expectedOutputFiles: [
        {
          attributionId: 'attribution-1',
          normalizedPath: 'Assets/Product/protected.png',
          outputBytes: protectedBytes.byteLength,
          outputSha256: sha256(protectedBytes),
        },
      ],
      response: new Response(archive),
    });

    expect(result.objectBytes).toBe(archive.byteLength);
    expect(result.objectSha256).toBe(sha256(archive));
    expect(result.outputTreeRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects host-to-storage byte substitution before receipt creation', async () => {
    const declared = new TextEncoder().encode('declared personalized output');
    const substituted = new TextEncoder().encode('substituted personalized output');
    const archive = zipSync({
      'Assets/Product/protected.png': substituted,
    });

    await expect(
      verifyRenditionReadback({
        expectedBytes: archive.byteLength,
        expectedObjectSha256: sha256(archive),
        expectedOutputFiles: [
          {
            attributionId: 'attribution-1',
            normalizedPath: 'Assets/Product/protected.png',
            outputBytes: declared.byteLength,
            outputSha256: sha256(declared),
          },
        ],
        response: new Response(archive),
      })
    ).rejects.toThrow('output');
  });

  test('rejects traversal entries during exact-version verification', async () => {
    const protectedBytes = new TextEncoder().encode('personalized output');
    const archive = zipSync({
      '../protected.png': protectedBytes,
    });

    await expect(
      verifyRenditionReadback({
        expectedBytes: archive.byteLength,
        expectedObjectSha256: sha256(archive),
        expectedOutputFiles: [],
        response: new Response(archive),
      })
    ).rejects.toThrow('path');
  });
});
