import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCasStore } from '../storage-core/desyncCas';
import { createIngestTusServer, INGEST_TUS_PATH } from './ingestTusServer';

const browserOrigin = 'https://app.example.test';
let scratchPath = '';
let server: HttpServer;
let serverOrigin = '';

beforeAll(async () => {
  scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-cors-'));
  server = createServer(
    createIngestTusServer({
      allowedOrigin: browserOrigin,
      catalog: null as never,
      store: localCasStore(join(scratchPath, 'cas')),
      indexDir: join(scratchPath, 'indexes'),
      uploadDir: join(scratchPath, 'uploads'),
      uploadHmacKey: 'cors-contract-test-hmac-key',
    })
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  serverOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(scratchPath, { force: true, recursive: true });
});

describe('ingest-tus browser CORS', () => {
  it('answers an allowed browser preflight before capability verification', async () => {
    const response = await fetch(`${serverOrigin}${INGEST_TUS_PATH}`, {
      method: 'OPTIONS',
      headers: {
        Origin: browserOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'content-type,tus-resumable,upload-length,upload-metadata,x-yucp-upload-exp,x-yucp-upload-sig,x-yucp-upload-version-id',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(browserOrigin);
  });
});
