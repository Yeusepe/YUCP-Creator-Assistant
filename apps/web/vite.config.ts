import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins-runtime';
import { parse as parseDotenv } from 'dotenv';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DIR = join(APP_DIR, '..', '..');
const LOCAL_WORKER_ENV_FILES = [join(APP_DIR, '.dev.vars'), join(REPO_ROOT_DIR, '.env.local')];

function loadLocalWorkerEnvFiles(): void {
  let loaded = 0;
  const loadedFiles: string[] = [];

  for (const filePath of LOCAL_WORKER_ENV_FILES) {
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parseDotenv(readFileSync(filePath, 'utf8'));
    let fileLoaded = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
        fileLoaded = true;
      }
    }

    if (fileLoaded) {
      loadedFiles.push(filePath);
    }
  }

  if (loaded > 0) {
    // eslint-disable-next-line no-console
    console.log(`[web] Loaded ${loaded} local Worker env values from ${loadedFiles.join(', ')}`);
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
  loadLocalWorkerEnvFiles();

  const allowedHosts = buildViteAllowedHosts();

  return {
    server: {
      allowedHosts,
      port: 3000,
    },
    preview: {
      allowedHosts,
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
      host: '0.0.0.0',
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    ssr: {
      noExternal: ['@convex-dev/better-auth'],
    },
    plugins: [
      cloudflare({ viteEnvironment: { name: 'ssr' } }),
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
  };
});
