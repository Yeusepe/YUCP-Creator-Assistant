import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startLocalWorkerProxy } from './localWorkerProxy';
import { startLocalWranglerWorker } from './localWranglerWorker';

async function main(): Promise<void> {
  const structuredLogs: unknown[] = [];
  const worker = await startLocalWranglerWorker({
    config: resolve('ops/testing/localWorkerProxy.wrangler.jsonc'),
    entrypoint: resolve('ops/testing/localWorkerProxy.fixture.ts'),
    onStructuredLog(log) {
      structuredLogs.push(log);
    },
    port: 0,
    vars: {},
  });
  let proxy: Awaited<ReturnType<typeof startLocalWorkerProxy>> | undefined;
  try {
    const directResponse = await worker.dispatch(new Request('http://worker.test/direct'));
    assert.equal(directResponse.status, 404);
    assert.equal(await directResponse.text(), '/direct');

    const loggedResponse = await worker.dispatch(new Request('http://worker.test/structured-log'));
    assert.equal(loggedResponse.status, 404);
    assert.equal(structuredLogs.length, 1);

    proxy = await startLocalWorkerProxy({
      allowedMethods: ['GET'],
      port: 0,
      upstreamBaseUrl: worker.baseUrl,
      upstreamFetch: worker.dispatch,
    });
    const response = await fetch(`${proxy.baseUrl}/probe`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '/probe');
    process.stdout.write('Local Wrangler Worker proxy integration passed.\n');
  } finally {
    await proxy?.stop();
    await worker.stop();
  }
}

void main();
