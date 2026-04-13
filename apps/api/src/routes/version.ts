/**
 * Version endpoint, returns the build ID injected at deploy time.
 *
 * Used by the web dashboard to detect when a new version has been deployed
 * so it can prompt the user to reload (version skew protection).
 *
 * GET /api/version → { buildId: string }
 *
 * The `BUILD_ID` env var should be set at build/deploy time (e.g., git SHA or
 * CI build number). It falls back to "dev" in local development.
 */

interface VersionResponse {
  buildId: string;
}

export function createVersionRouteHandler(): (request: Request) => Response | null {
  return (request: Request): Response | null => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/version' || request.method !== 'GET') {
      return null;
    }

    const body: VersionResponse = {
      buildId: process.env.BUILD_ID ?? 'dev',
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Allow the browser to cache for 60s, but always revalidate in background.
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  };
}
