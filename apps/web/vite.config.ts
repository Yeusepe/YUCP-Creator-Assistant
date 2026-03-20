import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

/**
 * Bootstrap Infisical secrets into process.env before Vite reads config values.
 * Mirrors the pattern used by apps/api and apps/bot.
 * At build time (Docker) the Infisical credentials are absent, so this is a no-op.
 * At runtime (vite preview) the credentials are injected by Zeabur and secrets load.
 */
async function bootstrapInfisicalSecrets(): Promise<void> {
  try {
    const { fetchInfisicalSecrets } = await import('@yucp/shared/infisical/fetchSecrets');
    const secrets = await fetchInfisicalSecrets();
    let loaded = 0;
    for (const [key, value] of Object.entries(secrets)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
      }
    }
    if (loaded > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[web] Loaded ${loaded} secrets from Infisical (env=${process.env.INFISICAL_ENV ?? 'dev'})`
      );
    }
  } catch {
    // Infisical not available (build time or local dev without creds) - continue with process.env
  }
}

function buildViteAllowedHosts(): string[] {
  return Array.from(
    new Set(
      buildAllowedBrowserOrigins({
        siteUrl: process.env.SITE_URL,
        frontendUrl: process.env.FRONTEND_URL,
      }).map((origin) => new URL(origin).hostname)
    )
  );
}

export default defineConfig(async () => {
  await bootstrapInfisicalSecrets();

  const allowedHosts = buildViteAllowedHosts();

  return {
    // Expose CONVEX_URL to client code via import.meta.env.CONVEX_URL.
    // This is a public URL (not a secret) so it's safe to embed in the client bundle.
    // The value comes from Infisical bootstrap (process.env.CONVEX_URL).
    define: {
      'import.meta.env.CONVEX_URL': JSON.stringify(process.env.CONVEX_URL),
      // Injected at build time for version skew detection (see versionPoller.ts).
      // In CI/CD, set BUILD_ID to the git SHA or pipeline run ID.
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(process.env.BUILD_ID ?? 'dev'),
    },
    server: {
      allowedHosts,
      port: 3000,
    },
    preview: {
      allowedHosts,
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
      host: '0.0.0.0',
    },
    ssr: {
      noExternal: ['@convex-dev/better-auth'],
    },
    plugins: [
      tsConfigPaths(),
      tailwindcss(),
      tanstackStart({
        tsr: {
          appDirectory: './src',
          autoCodeSplitting: true,
        },
      }),
      viteReact(),
    ],
    environments: {
      client: {
        build: {
          rollupOptions: {
            output: {
              manualChunks: {
                three: ['three', '@react-three/fiber', '@react-three/drei'],
              },
            },
          },
        },
      },
    },
  };
});
