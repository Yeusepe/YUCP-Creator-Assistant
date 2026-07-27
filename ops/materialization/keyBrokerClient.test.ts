import { describe, expect, it } from 'bun:test';
import { createMaterializationKeyBrokerClient } from './keyBrokerClient';

const sharedSecret = 'test-materialization-key-broker-secret';

describe('private materialization key broker client', () => {
  it('prepares one pseudonymous subject without receiving materialization keys', async () => {
    let received: Request | undefined;
    const client = createMaterializationKeyBrokerClient({
      baseUrl: 'http://127.0.0.1:8789',
      fetchImplementation: async (request) => {
        received = request;
        return Response.json({
          buyerSubjectPseudonym: Buffer.alloc(32, 0x21).toString('base64url'),
          encryptedSubjectMapping: Buffer.alloc(48, 0x22).toString('base64url'),
          pseudonymMethod: 'hmac-sha256-hkdf-v2',
        });
      },
      sharedSecret,
    });
    const result = await client.prepareSubject({
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      jobId: 'job-1',
      keyEpoch: 7,
      productId: 'product-1',
    });
    expect(result.buyerSubjectPseudonym).toBe(Buffer.alloc(32, 0x21).toString('base64url'));
    expect(result.encryptedSubjectMapping).toEqual(new Uint8Array(48).fill(0x22));
    expect(received?.url).toBe('http://127.0.0.1:8789/v2/internal/key-broker/subjects/prepare');
    expect(received?.headers.get('authorization')).toBe(`Bearer ${sharedSecret}`);
    const body = await received?.json();
    expect(body).toMatchObject({
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      jobId: 'job-1',
      productId: 'product-1',
    });
    expect(JSON.stringify(body)).not.toContain(sharedSecret);
  });

  it('rejects a malformed private response', async () => {
    const client = createMaterializationKeyBrokerClient({
      baseUrl: 'http://127.0.0.1:8789',
      fetchImplementation: async () =>
        Response.json({
          buyerSubjectPseudonym: 'invalid!',
          encryptedSubjectMapping: 'also-invalid!',
          pseudonymMethod: 'method',
        }),
      sharedSecret,
    });
    await expect(
      client.prepareSubject({
        buyerId: 'buyer-1',
        creatorId: 'creator-1',
        jobId: 'job-1',
        keyEpoch: 7,
        productId: 'product-1',
      })
    ).rejects.toThrow('Materialization key broker encrypted subject mapping is invalid');
  });
});
