import { connect, createServer, isIP, type Server, type Socket } from 'node:net';

const MAXIMUM_ROUTES = 8;
const MAXIMUM_CONNECTIONS_PER_ROUTE = 64;
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

export type LocalTcpBridgeRoute = {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
};

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function requirePort(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

export function validateBridgeRoutes(
  routes: readonly LocalTcpBridgeRoute[]
): LocalTcpBridgeRoute[] {
  if (routes.length < 1 || routes.length > MAXIMUM_ROUTES) {
    throw new Error('The local WSL bridge route count is invalid');
  }
  const listeners = new Set<string>();
  return routes.map((route) => {
    if (isIP(route.listenHost) !== 4 || route.listenHost === '0.0.0.0') {
      throw new Error('A local WSL bridge listener must use one specific IPv4 address');
    }
    if (
      isIP(route.targetHost) !== 4 ||
      (route.targetHost !== '127.0.0.1' && !isPrivateIpv4(route.targetHost))
    ) {
      throw new Error('A local WSL bridge route must use an approved target address');
    }
    const normalized = {
      listenHost: route.listenHost,
      listenPort: requirePort(route.listenPort, 'Bridge listener port'),
      targetHost: route.targetHost,
      targetPort: requirePort(route.targetPort, 'Bridge target port'),
    };
    const listener = `${normalized.listenHost}:${normalized.listenPort}`;
    if (listeners.has(listener)) {
      throw new Error('A local WSL bridge listener is duplicated');
    }
    listeners.add(listener);
    return normalized;
  });
}

export class LocalTcpBridge {
  readonly #routes: LocalTcpBridgeRoute[];
  readonly #servers: Server[] = [];
  readonly #sockets = new Set<Socket>();
  #started = false;

  constructor(routes: readonly LocalTcpBridgeRoute[]) {
    this.#routes = validateBridgeRoutes(routes);
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error('The local WSL bridge is already started');
    }
    this.#started = true;
    try {
      for (const route of this.#routes) {
        const server = createServer((downstream) => {
          this.#sockets.add(downstream);
          downstream.setTimeout(IDLE_TIMEOUT_MS, () => downstream.destroy());
          const upstream = connect({
            host: route.targetHost,
            port: route.targetPort,
          });
          this.#sockets.add(upstream);
          upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
          const closePair = () => {
            downstream.destroy();
            upstream.destroy();
          };
          downstream.once('error', closePair);
          upstream.once('error', closePair);
          downstream.once('close', () => this.#sockets.delete(downstream));
          upstream.once('close', () => this.#sockets.delete(upstream));
          downstream.pipe(upstream).pipe(downstream);
        });
        server.maxConnections = MAXIMUM_CONNECTIONS_PER_ROUTE;
        this.#servers.push(server);
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(route.listenPort, route.listenHost);
        });
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    await Promise.all(
      this.#servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          })
      )
    );
    this.#servers.length = 0;
    this.#started = false;
  }
}
