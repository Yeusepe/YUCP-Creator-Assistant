const targetCwd = process.env.YUCP_TEST_CWD?.trim();

if (!targetCwd) {
  throw new Error('YUCP_TEST_CWD must be set');
}

process.chdir(targetCwd);

await import(new URL('../../src/index.ts', import.meta.url).href);

export {};
