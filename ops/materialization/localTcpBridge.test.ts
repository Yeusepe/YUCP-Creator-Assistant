import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { LocalTcpBridge, type LocalTcpBridgeRoute, validateBridgeRoutes } from './localTcpBridge';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }
  return address.port;
}

describe('local WSL TCP bridge', () => {
  test('rejects broad listeners and non-loopback Windows targets', () => {
    expect(() =>
      validateBridgeRoutes([
        {
          listenHost: '0.0.0.0',
          listenPort: 30_012,
          targetHost: '127.0.0.1',
          targetPort: 3_012,
        },
      ])
    ).toThrow('specific IPv4');
    expect(() =>
      validateBridgeRoutes([
        {
          listenHost: '127.0.0.1',
          listenPort: 8_788,
          targetHost: '192.0.2.10',
          targetPort: 8_788,
        },
      ])
    ).toThrow('approved target');
  });

  test('forwards bytes through one bounded route', async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const listenPort = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const routes: LocalTcpBridgeRoute[] = [
      {
        listenHost: '127.0.0.1',
        listenPort,
        targetHost: '127.0.0.1',
        targetPort: upstreamPort,
      },
    ];
    const bridge = new LocalTcpBridge(routes);
    try {
      await bridge.start();
      await new Promise<void>((resolve, reject) => {
        void Bun.connect({
          hostname: '127.0.0.1',
          port: listenPort,
          socket: {
            close() {
              resolve();
            },
            data(socket, data) {
              expect(Buffer.from(data).toString('utf8')).toBe('bridge-ok');
              socket.end();
            },
            error(_socket, error) {
              reject(error);
            },
            open(socket) {
              socket.write('bridge-ok');
            },
          },
        }).catch(reject);
      });
    } finally {
      await bridge.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
