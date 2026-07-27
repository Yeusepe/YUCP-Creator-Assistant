import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type BrowserDriverRequest,
  MAX_BROWSER_DRIVER_MESSAGE_BYTES,
  parseBrowserDriverRequest,
} from './nodeBrowserLifecycleProtocol';

const DRIVER_ENTRY = fileURLToPath(new URL('./nodeBrowserLifecycleDriver.ts', import.meta.url));
const REQUEST_TIMEOUT_MS = 240_000;
const STOP_TIMEOUT_MS = 10_000;
const DRIVER_ENVIRONMENT_ALLOWLIST = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

type DriverResponse = {
  error?: {
    code: string;
    step?: string;
  };
  ok: boolean;
  runId: string;
  sequence: number;
  result?: unknown;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type NodeBrowserLifecycleTestOptions = {
  driverArguments: string[];
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
};

export class NodeBrowserLifecycleError extends Error {
  readonly code: string;
  readonly step?: string;

  constructor(code: string, step?: string) {
    super(code);
    this.name = 'NodeBrowserLifecycleError';
    this.code = code;
    this.step = step;
  }
}

export interface NodeBrowserLifecycle {
  buyerAuthorizeUnity: (authorizationUrl: string) => Promise<void>;
  buyerNavigate: (url: string) => Promise<void>;
  buyerVerify: (input: {
    catalogProductId: string;
    licenseKey: string;
    webUrl: string;
  }) => Promise<void>;
  creatorUpload: (input: {
    packageId: string;
    packagePath: string;
    productName: string;
    version: string;
    webUrl: string;
  }) => Promise<void>;
  creatorEnsureVccLink: (input: {
    catalogProductId: string;
    webUrl: string;
  }) => Promise<{ addRepoUrl: string; indexUrl: string }>;
  enrollPasskeys: (input: {
    buyerEnrollmentCapability: string;
    creatorEnrollmentCapability: string;
    webUrl: string;
  }) => Promise<void>;
  smoke: () => Promise<{ title: string }>;
  stop: () => Promise<void>;
}

export function buildNodeBrowserDriverEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && DRIVER_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

export async function writeBrowserDriverLine(stream: Writable, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return Promise.race([
    once(child, 'close').then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function startNodeBrowserLifecycleProcess(options: {
  driverArguments: string[];
  requestTimeoutMs: number;
  stopTimeoutMs: number;
}): Promise<NodeBrowserLifecycle> {
  const child = spawn('node', options.driverArguments, {
    cwd: process.cwd(),
    env: buildNodeBrowserDriverEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.resume();
  const runId = randomUUID();
  const pending = new Map<number, PendingRequest>();
  let nextSequence = 1;
  let expectedResponseSequence = 1;
  let terminalError: NodeBrowserLifecycleError | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const lines = createInterface({ input: child.stdout });
  const failPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const terminateDriver = (error: NodeBrowserLifecycleError): void => {
    if (terminalError) {
      return;
    }
    terminalError = error;
    failPending(error);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, options.stopTimeoutMs);
      forceKillTimer.unref?.();
    }
  };
  lines.on('line', (line) => {
    if (terminalError) {
      return;
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_BROWSER_DRIVER_MESSAGE_BYTES) {
      terminateDriver(new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID'));
      return;
    }
    let response: DriverResponse;
    try {
      response = JSON.parse(line) as DriverResponse;
    } catch {
      terminateDriver(new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID'));
      return;
    }
    if (response.runId !== runId || response.sequence !== expectedResponseSequence) {
      terminateDriver(new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID'));
      return;
    }
    expectedResponseSequence += 1;
    const request = pending.get(response.sequence);
    if (!request) {
      return;
    }
    pending.delete(response.sequence);
    clearTimeout(request.timeout);
    if (!response.ok) {
      request.reject(
        new NodeBrowserLifecycleError(
          response.error?.code ?? 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_FAILED',
          response.error?.step
        )
      );
      return;
    }
    request.resolve(response.result);
  });
  child.once('close', (code) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    const closeError =
      terminalError ??
      new NodeBrowserLifecycleError(
        code === 0
          ? 'PACKAGE_LIFECYCLE_BROWSER_DRIVER_CLOSED'
          : 'PACKAGE_LIFECYCLE_BROWSER_DRIVER_FAILED'
      );
    terminalError ??= closeError;
    failPending(closeError);
  });

  const request = async <T>(
    method: BrowserDriverRequest['method'],
    params?: Record<string, unknown>
  ): Promise<T> => {
    if (terminalError) {
      throw terminalError;
    }
    if (child.exitCode !== null || !child.stdin?.writable) {
      throw new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_DRIVER_CLOSED');
    }
    const sequence = nextSequence;
    nextSequence += 1;
    const requestValue = parseBrowserDriverRequest({
      method,
      ...(params === undefined ? {} : { params }),
      runId,
      sequence,
    });
    const serialized = JSON.stringify(requestValue);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BROWSER_DRIVER_MESSAGE_BYTES) {
      throw new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID');
    }
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminateDriver(new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_COMMAND_TIMEOUT'));
      }, options.requestTimeoutMs);
      pending.set(sequence, {
        reject,
        resolve: (value) => resolve(value as T),
        timeout,
      });
    });
    try {
      await writeBrowserDriverLine(child.stdin, `${serialized}\n`);
    } catch {
      terminateDriver(new NodeBrowserLifecycleError('PACKAGE_LIFECYCLE_BROWSER_DRIVER_FAILED'));
    }
    return await response;
  };

  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        if (child.exitCode === null) {
          await request('stop').catch(() => undefined);
          child.stdin?.end();
          await waitForExit(child, options.stopTimeoutMs);
        }
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await waitForExit(child, options.stopTimeoutMs);
        }
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        lines.close();
      })();
    }
    await stopPromise;
  };

  return {
    buyerAuthorizeUnity: async (authorizationUrl) => {
      await request('buyerAuthorizeUnity', { authorizationUrl });
    },
    buyerNavigate: async (url) => {
      await request('buyerNavigate', { url });
    },
    buyerVerify: async (input) => {
      await request('buyerVerify', input);
    },
    creatorUpload: async (input) => {
      await request('creatorUpload', input);
    },
    creatorEnsureVccLink: async (input) =>
      await request<{ addRepoUrl: string; indexUrl: string }>('creatorEnsureVccLink', input),
    enrollPasskeys: async (input) => {
      await request('enrollPasskeys', input);
    },
    smoke: async () => await request<{ title: string }>('smoke'),
    stop,
  };
}

export async function startNodeBrowserLifecycle(): Promise<NodeBrowserLifecycle> {
  return await startNodeBrowserLifecycleProcess({
    driverArguments: buildNodeBrowserDriverArguments(),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
  });
}

export async function startNodeBrowserLifecycleForTest(
  options: NodeBrowserLifecycleTestOptions
): Promise<NodeBrowserLifecycle> {
  return await startNodeBrowserLifecycleProcess({
    driverArguments: options.driverArguments,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    stopTimeoutMs: options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
  });
}

export function buildNodeBrowserDriverArguments(): string[] {
  return ['--import', 'tsx', DRIVER_ENTRY];
}
