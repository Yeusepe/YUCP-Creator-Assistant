import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const ROUTE_PATTERN = /^\/api\/v2\/package-installer\/tuf\/(metadata|targets)\/(.+)$/;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_BYTES = 64 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function response(body: BodyInit | null, status: number, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function decodeSafePath(value: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.startsWith('/') || decoded.includes('\0')) {
    return null;
  }
  const segments = decoded.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return segments;
}

export function createPackageInstallerTufRoute(
  configuredRoot: string
): (request: Request) => Promise<Response> {
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error('PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT must be absolute');
  }
  const rootPromise = realpath(configuredRoot);
  return async (request) => {
    if (request.method !== 'GET') {
      return response('Method not allowed', 405, {
        allow: 'GET',
        'content-type': 'text/plain; charset=utf-8',
      });
    }
    const match = ROUTE_PATTERN.exec(new URL(request.url).pathname);
    const role = match?.[1];
    const segments = match?.[2] ? decodeSafePath(match[2]) : null;
    if ((role !== 'metadata' && role !== 'targets') || !segments) {
      return response('Not found', 404, {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
    try {
      const repositoryRoot = await rootPromise;
      const roleRoot = await realpath(path.join(repositoryRoot, role));
      const candidate = path.join(roleRoot, ...segments);
      const resolved = await realpath(candidate);
      const boundary = `${roleRoot}${path.sep}`;
      if (!resolved.startsWith(boundary)) {
        return response('Not found', 404, {
          'content-type': 'text/plain; charset=utf-8',
        });
      }
      const stat = await lstat(resolved);
      const limit = role === 'metadata' ? MAX_METADATA_BYTES : MAX_TARGET_BYTES;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
        return response('Not found', 404, {
          'content-type': 'text/plain; charset=utf-8',
        });
      }
      const bytes = await readFile(resolved);
      const isTimestamp = role === 'metadata' && segments.at(-1) === 'timestamp.json';
      return response(bytes, 200, {
        'cache-control': isTimestamp
          ? 'public, max-age=0, must-revalidate'
          : role === 'metadata'
            ? 'public, max-age=60, must-revalidate'
            : 'public, max-age=31536000, immutable',
        'content-length': String(bytes.byteLength),
        'content-type':
          role === 'metadata' || resolved.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
      });
    } catch {
      return response('Not found', 404, {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
  };
}
