import { describe, expect, it, mock } from 'bun:test';
import { loadCasConfig } from './config';
import {
  BackblazeB2ExactVersionDeletionPort,
  ExactVersionDeletionBlockedError,
} from './exactVersionDeletion';

function config() {
  return loadCasConfig({
    CAS_S3_ACCESS_KEY_ID: 'application-key-id',
    CAS_S3_BUCKET: 'yucp-common-prod',
    CAS_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    CAS_S3_REGION: 'us-east-005',
    CAS_S3_SECRET_ACCESS_KEY: 'application-key-secret',
  });
}

describe('Backblaze exact-version deletion', () => {
  it('authorizes a delete-only key and deletes by native file ID without governance bypass', async () => {
    const requests: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ init, input: String(input) });
      if (requests.length === 1) {
        return Response.json({
          accountId: 'account-id',
          apiInfo: {
            storageApi: {
              allowed: {
                buckets: [{ id: 'bucket-id', name: 'yucp-common-prod' }],
                capabilities: ['deleteFiles'],
                namePrefix: null,
              },
              apiUrl: 'https://api005.backblazeb2.com',
              downloadUrl: 'https://f005.backblazeb2.com',
              s3ApiUrl: 'https://s3.us-east-005.backblazeb2.com',
            },
          },
          applicationKeyExpirationTimestamp: null,
          authorizationToken: 'native-auth-token',
        });
      }
      return Response.json({
        fileId: '4_z-file-id',
        fileName: 'v2/common/chunks/aa/digest',
      });
    });
    const port = new BackblazeB2ExactVersionDeletionPort({ common: config() }, fetchImpl);

    await port.deleteExactVersion({
      fileIdentifier: '4_z-file-id',
      objectKey: 'v2/common/chunks/aa/digest',
      providerVersion: '4_z-file-id',
      role: 'common',
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      input: 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account',
      init: {
        method: 'GET',
      },
    });
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toStartWith('Basic ');
    expect(requests[1]).toMatchObject({
      input: 'https://api005.backblazeb2.com/b2api/v4/b2_delete_file_version',
      init: {
        body: JSON.stringify({
          fileId: '4_z-file-id',
          fileName: 'v2/common/chunks/aa/digest',
        }),
        method: 'POST',
      },
    });
    expect(new Headers(requests[1]?.init?.headers).get('authorization')).toBe('native-auth-token');
  });

  it('rejects a key that does not have deleteFiles capability', async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        accountId: 'account-id',
        apiInfo: {
          storageApi: {
            allowed: {
              buckets: [{ id: 'bucket-id', name: 'yucp-common-prod' }],
              capabilities: ['listFiles'],
              namePrefix: null,
            },
            apiUrl: 'https://api005.backblazeb2.com',
            downloadUrl: 'https://f005.backblazeb2.com',
            s3ApiUrl: 'https://s3.us-east-005.backblazeb2.com',
          },
        },
        applicationKeyExpirationTimestamp: null,
        authorizationToken: 'native-auth-token',
      })
    );
    const port = new BackblazeB2ExactVersionDeletionPort({ common: config() }, fetchImpl);

    await expect(
      port.deleteExactVersion({
        fileIdentifier: '4_z-file-id',
        objectKey: 'v2/common/chunks/aa/digest',
        providerVersion: '4_z-file-id',
        role: 'common',
      })
    ).rejects.toThrow('deleteFiles capability');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats an already absent exact file version as an idempotent deletion', async () => {
    let requests = 0;
    const fetchImpl = mock(async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({
          accountId: 'account-id',
          apiInfo: {
            storageApi: {
              allowed: {
                buckets: [{ id: 'bucket-id', name: 'yucp-common-prod' }],
                capabilities: ['deleteFiles'],
                namePrefix: null,
              },
              apiUrl: 'https://api005.backblazeb2.com',
              downloadUrl: 'https://f005.backblazeb2.com',
              s3ApiUrl: 'https://s3.us-east-005.backblazeb2.com',
            },
          },
          applicationKeyExpirationTimestamp: null,
          authorizationToken: 'native-auth-token',
        });
      }
      return Response.json(
        {
          code: 'file_not_present',
          message: 'File not present',
          status: 400,
        },
        { status: 400 }
      );
    });
    const port = new BackblazeB2ExactVersionDeletionPort({ common: config() }, fetchImpl);

    await expect(
      port.deleteExactVersion({
        fileIdentifier: '4_z-file-id',
        objectKey: 'v2/common/chunks/aa/digest',
        providerVersion: '4_z-file-id',
        role: 'common',
      })
    ).resolves.toBeUndefined();
  });

  it('reports Object Lock denial as a retryable blocked deletion', async () => {
    let requests = 0;
    const fetchImpl = mock(async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({
          accountId: 'account-id',
          apiInfo: {
            storageApi: {
              allowed: {
                buckets: [{ id: 'bucket-id', name: 'yucp-common-prod' }],
                capabilities: ['deleteFiles'],
                namePrefix: null,
              },
              apiUrl: 'https://api005.backblazeb2.com',
              downloadUrl: 'https://f005.backblazeb2.com',
              s3ApiUrl: 'https://s3.us-east-005.backblazeb2.com',
            },
          },
          applicationKeyExpirationTimestamp: null,
          authorizationToken: 'native-auth-token',
        });
      }
      return Response.json(
        {
          code: 'access_denied',
          message: 'Access Denied',
          status: 401,
        },
        { status: 401 }
      );
    });
    const port = new BackblazeB2ExactVersionDeletionPort({ common: config() }, fetchImpl);

    await expect(
      port.deleteExactVersion({
        fileIdentifier: '4_z-file-id',
        objectKey: 'v2/common/chunks/aa/digest',
        providerVersion: '4_z-file-id',
        role: 'common',
      })
    ).rejects.toBeInstanceOf(ExactVersionDeletionBlockedError);
  });
});
