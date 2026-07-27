import { resolveLocalImporterPackagePath } from './localVpmRepository';
import { buildPinnedLocalImporterRepository } from './publicImporterRelease';

const DEFAULT_PORT = 3004;

function resolvePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port');
  }
  return port;
}

async function main(): Promise<void> {
  const port = resolvePort(process.env.PORT);
  const hostname = '127.0.0.1';
  const baseUrl = `http://${hostname}:${port}`;
  const importerPath = await resolveLocalImporterPackagePath();
  const repository = await buildPinnedLocalImporterRepository({
    baseUrl,
    importerPath,
  });
  const indexBytes = new TextEncoder().encode(`${JSON.stringify(repository.index)}\n`);
  const archiveBytes = new Uint8Array(repository.archive);

  const server = Bun.serve({
    hostname,
    port,
    fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
      }
      const url = new URL(request.url);
      if (url.pathname === '/index.json') {
        return new Response(request.method === 'HEAD' ? null : indexBytes, {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Length': String(indexBytes.byteLength),
            'Content-Type': 'application/json; charset=utf-8',
          },
        });
      }
      if (url.pathname === repository.archivePath) {
        return new Response(request.method === 'HEAD' ? null : archiveBytes, {
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': String(archiveBytes.byteLength),
            'Content-Type': 'application/zip',
          },
        });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  console.log(
    JSON.stringify({
      archiveBytes: archiveBytes.byteLength,
      event: 'local_vpm.listening',
      importerVersion:
        repository.index.packages['com.yucp.importer']?.versions &&
        Object.keys(repository.index.packages['com.yucp.importer'].versions)[0],
      port: server.port,
    })
  );
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop);
    process.once('SIGTERM', resolveStop);
  });
  server.stop(true);
}

await main();
