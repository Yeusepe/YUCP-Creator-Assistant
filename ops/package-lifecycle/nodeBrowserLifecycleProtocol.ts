const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SEQUENCE = 1_000_000;
const MAX_URL_LENGTH = 2048;

export const MAX_BROWSER_DRIVER_MESSAGE_BYTES = 1024 * 1024;

type BuyerNavigateRequest = {
  method: 'buyerNavigate';
  params: {
    url: string;
  };
  runId: string;
  sequence: number;
};

type BuyerAuthorizeUnityRequest = {
  method: 'buyerAuthorizeUnity';
  params: {
    authorizationUrl: string;
  };
  runId: string;
  sequence: number;
};

type BuyerVerifyRequest = {
  method: 'buyerVerify';
  params: {
    catalogProductId: string;
    licenseKey: string;
    webUrl: string;
  };
  runId: string;
  sequence: number;
};

type CreatorUploadRequest = {
  method: 'creatorUpload';
  params: {
    packageId: string;
    packagePath: string;
    productName: string;
    version: string;
    webUrl: string;
  };
  runId: string;
  sequence: number;
};

type CreatorEnsureVccLinkRequest = {
  method: 'creatorEnsureVccLink';
  params: {
    catalogProductId: string;
    webUrl: string;
  };
  runId: string;
  sequence: number;
};

type EnrollPasskeysRequest = {
  method: 'enrollPasskeys';
  params: {
    buyerEnrollmentCapability: string;
    creatorEnrollmentCapability: string;
    webUrl: string;
  };
  runId: string;
  sequence: number;
};

type ParameterlessRequest = {
  method: 'smoke' | 'stop';
  runId: string;
  sequence: number;
};

export type BrowserDriverRequest =
  | BuyerAuthorizeUnityRequest
  | BuyerNavigateRequest
  | BuyerVerifyRequest
  | CreatorEnsureVccLinkRequest
  | CreatorUploadRequest
  | EnrollPasskeysRequest
  | ParameterlessRequest;

export class BrowserDriverProtocolError extends Error {
  constructor() {
    super('PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID');
    this.name = 'BrowserDriverProtocolError';
  }
}

function rejectProtocol(): never {
  throw new BrowserDriverProtocolError();
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    rejectProtocol();
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    rejectProtocol();
  }
}

function requireString(value: Record<string, unknown>, key: string, maximumLength: number): string {
  const candidate = value[key];
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > maximumLength ||
    candidate.includes('\0')
  ) {
    rejectProtocol();
  }
  return candidate;
}

function requireHttpUrl(value: Record<string, unknown>, key: string): string {
  const candidate = requireString(value, key, MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    rejectProtocol();
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    rejectProtocol();
  }
  return candidate;
}

function validateParameters(
  method: BrowserDriverRequest['method'],
  value: Record<string, unknown>
): void {
  if (method === 'smoke' || method === 'stop') {
    requireExactKeys(value, ['method', 'runId', 'sequence']);
    return;
  }

  requireExactKeys(value, ['method', 'params', 'runId', 'sequence']);
  const params = requireRecord(value.params);
  if (method === 'buyerNavigate') {
    requireExactKeys(params, ['url']);
    requireHttpUrl(params, 'url');
    return;
  }
  if (method === 'buyerAuthorizeUnity') {
    requireExactKeys(params, ['authorizationUrl']);
    requireHttpUrl(params, 'authorizationUrl');
    return;
  }
  if (method === 'buyerVerify') {
    requireExactKeys(params, ['catalogProductId', 'licenseKey', 'webUrl']);
    requireString(params, 'catalogProductId', 256);
    requireString(params, 'licenseKey', 4096);
    requireHttpUrl(params, 'webUrl');
    return;
  }
  if (method === 'creatorUpload') {
    requireExactKeys(params, ['packageId', 'packagePath', 'productName', 'version', 'webUrl']);
    requireString(params, 'packageId', 256);
    requireString(params, 'packagePath', 32_767);
    requireString(params, 'productName', 512);
    requireString(params, 'version', 128);
    requireHttpUrl(params, 'webUrl');
    return;
  }
  if (method === 'creatorEnsureVccLink') {
    requireExactKeys(params, ['catalogProductId', 'webUrl']);
    requireString(params, 'catalogProductId', 256);
    requireHttpUrl(params, 'webUrl');
    return;
  }
  requireExactKeys(params, ['buyerEnrollmentCapability', 'creatorEnrollmentCapability', 'webUrl']);
  requireString(params, 'buyerEnrollmentCapability', 1024);
  requireString(params, 'creatorEnrollmentCapability', 1024);
  requireHttpUrl(params, 'webUrl');
}

export function parseBrowserDriverRequest(value: unknown): BrowserDriverRequest {
  const record = requireRecord(value);
  const method = record.method;
  if (
    method !== 'buyerNavigate' &&
    method !== 'buyerAuthorizeUnity' &&
    method !== 'buyerVerify' &&
    method !== 'creatorUpload' &&
    method !== 'creatorEnsureVccLink' &&
    method !== 'enrollPasskeys' &&
    method !== 'smoke' &&
    method !== 'stop'
  ) {
    rejectProtocol();
  }
  if (
    typeof record.runId !== 'string' ||
    !RUN_ID_PATTERN.test(record.runId) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    (record.sequence as number) > MAX_SEQUENCE
  ) {
    rejectProtocol();
  }
  validateParameters(method, record);
  return record as BrowserDriverRequest;
}
