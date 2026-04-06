import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIST_DIR = resolve(APP_DIR, 'dist/client');
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOSTNAME = '0.0.0.0';

async function bootstrapInfisicalSecrets(): Promise<void> {
  try {
    const secrets = await fetchInfisicalSecrets();
    let loaded = 0;

    for (const [key, value] of Object.entries(secrets)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
      }
    }

    if (loaded > 0) {
      console.log(
        `[web] Loaded ${loaded} secrets from Infisical (env=${process.env.INFISICAL_ENV ?? 'dev'})`
      );
    }
  } catch {
    // Infisical is optional for local and build-time flows.
  }
}

await bootstrapInfisicalSecrets();

const serverModule = (await import(new URL('./dist/server/server.js', import.meta.url).href)) as {
  default: {
    fetch(request: Request): Promise<Response>;
  };
};

function resolveStaticAssetPath(pathname: string): string | null {
  const normalizedPath = pathname.replace(/\\/g, '/');
  if (normalizedPath.endsWith('/')) {
    return null;
  }

  const relativePath = normalizedPath.replace(/^\/+/, '');
  if (!relativePath || !extname(relativePath)) {
    return null;
  }

  const resolvedPath = resolve(CLIENT_DIST_DIR, relativePath);
  const allowedPrefix = `${CLIENT_DIST_DIR}${sep}`;

  if (resolvedPath !== CLIENT_DIST_DIR && !resolvedPath.startsWith(allowedPrefix)) {
    return null;
  }

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    return null;
  }

  return resolvedPath;
}

function buildCacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }

  return 'public, max-age=3600';
}

async function serveStaticAsset(request: Request): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }

  const url = new URL(request.url);
  const assetPath = resolveStaticAssetPath(url.pathname);
  if (!assetPath) {
    return null;
  }

  const file = Bun.file(assetPath);
  const headers = new Headers({
    'Cache-Control': buildCacheControl(url.pathname),
  });

  if (file.type) {
    headers.set('Content-Type', file.type);
  }

  if (request.method === 'HEAD') {
    const stats = statSync(assetPath);
    headers.set('Content-Length', `${stats.size}`);
    return new Response(null, { headers });
  }

  return new Response(file, { headers });
}

const server = Bun.serve({
  fetch: async (request) => {
    const staticResponse = await serveStaticAsset(request);
    if (staticResponse) {
      return staticResponse;
    }

    return serverModule.default.fetch(request);
  },
  hostname: HOSTNAME,
  port: PORT,
});

console.log(`[web] Serving TanStack app on http://${HOSTNAME}:${server.port}`);
