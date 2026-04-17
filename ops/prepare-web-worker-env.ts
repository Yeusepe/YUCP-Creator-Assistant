import { existsSync, readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import {
  getWebLocalEnvValues,
  REPO_ROOT_ENV_LOCAL_PATH,
  resolveWebEnvValues,
  WEB_LOCAL_ENV_PATH,
  writeDotenvFile,
} from './cloudflare-web-config';

function normalizeSource(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value?.trim()] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

const PROCESS_ENV_REFRESH_KEYS = [
  'API_BASE_URL',
  'CONVEX_SITE_URL',
  'CONVEX_URL',
  'FRONTEND_URL',
  'INTERNAL_RPC_SHARED_SECRET',
  'SITE_URL',
] as const;

export function hasProcessWorkerBindings(source: Record<string, string | undefined>): boolean {
  return PROCESS_ENV_REFRESH_KEYS.some((key) => Boolean(source[key]?.trim()));
}

function main(): void {
  const normalizedProcessEnv = normalizeSource(process.env);
  const envSource = getWebLocalEnvValues(
    resolveWebEnvValues(normalizedProcessEnv, { prod: false })
  );
  if (Object.keys(envSource).length > 0 && hasProcessWorkerBindings(normalizedProcessEnv)) {
    writeDotenvFile(WEB_LOCAL_ENV_PATH, envSource);
    console.log(
      `prepare-web-worker-env: wrote ${Object.keys(envSource).length} vars to ${WEB_LOCAL_ENV_PATH} from process.env`
    );
    return;
  }

  if (!existsSync(REPO_ROOT_ENV_LOCAL_PATH)) {
    return;
  }

  const source = normalizeSource(parseDotenv(readFileSync(REPO_ROOT_ENV_LOCAL_PATH, 'utf8')));
  const resolved = resolveWebEnvValues(source, { prod: false });
  const localValues = getWebLocalEnvValues(resolved);

  if (Object.keys(localValues).length === 0) {
    return;
  }

  writeDotenvFile(WEB_LOCAL_ENV_PATH, localValues);
  console.log(
    `prepare-web-worker-env: refreshed ${Object.keys(localValues).length} vars in ${WEB_LOCAL_ENV_PATH} from ${REPO_ROOT_ENV_LOCAL_PATH}`
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error('prepare-web-worker-env:', error);
    process.exit(1);
  }
}
