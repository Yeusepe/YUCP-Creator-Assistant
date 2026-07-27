const PREPARE_SUBJECT_PATH = '/v2/internal/key-broker/subjects/prepare';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_RESPONSE_BYTES = 256 * 1024;

export type PreparedMaterializationSubject = {
  buyerSubjectPseudonym: string;
  encryptedSubjectMapping: Uint8Array;
  pseudonymMethod: string;
};

export interface MaterializationKeyBrokerPort {
  prepareSubject(input: {
    buyerId: string;
    creatorId: string;
    jobId: string;
    keyEpoch: number;
    productId: string;
  }): Promise<PreparedMaterializationSubject>;
}

export interface MaterializationKeyBrokerClientConfig {
  baseUrl: string;
  fetchImplementation?: (request: Request) => Promise<Response>;
  sharedSecret: string;
  timeoutMs?: number;
}

function requireBaseUrl(value: string): string {
  const parsed = new URL(value);
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Materialization key broker URL must be an HTTPS or loopback HTTP origin');
  }
  return parsed.origin;
}

function requireText(value: unknown, name: string, maximumBytes = 512): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value.trim(), 'utf8') > maximumBytes
  ) {
    throw new Error(`Materialization key broker ${name} is invalid`);
  }
  return value.trim();
}

function requireBase64Url(value: unknown, name: string, maximumBytes = 256 * 1024): string {
  const text = requireText(value, name, maximumBytes);
  if (!BASE64URL_PATTERN.test(text)) {
    throw new Error(`Materialization key broker ${name} is invalid`);
  }
  return text;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Materialization key broker returned an invalid response');
  }
  return value as Record<string, unknown>;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw new Error('Materialization key broker returned an invalid response');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAXIMUM_RESPONSE_BYTES) {
    throw new Error('Materialization key broker returned an invalid response');
  }
  if (!response.ok) {
    throw new Error(`Materialization key broker rejected the request with HTTP ${response.status}`);
  }
  try {
    return requireObject(JSON.parse(text));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Materialization key broker returned an invalid response'
    ) {
      throw error;
    }
    throw new Error('Materialization key broker returned an invalid response');
  }
}

export function createMaterializationKeyBrokerClient(
  config: MaterializationKeyBrokerClientConfig
): MaterializationKeyBrokerPort {
  const baseUrl = requireBaseUrl(config.baseUrl);
  const sharedSecret = config.sharedSecret.trim();
  if (Buffer.byteLength(sharedSecret, 'utf8') < 24) {
    throw new Error(
      'Materialization key broker shared secret must contain at least 24 UTF-8 bytes'
    );
  }
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Materialization key broker timeout is invalid');
  }
  const fetchImplementation = config.fetchImplementation ?? ((request: Request) => fetch(request));

  const post = async (
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> =>
    readResponse(
      await fetchImplementation(
        new Request(`${baseUrl}${path}`, {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
      )
    );

  return {
    async prepareSubject(input) {
      const response = await post(PREPARE_SUBJECT_PATH, input);
      const encryptedSubjectMapping = requireBase64Url(
        response.encryptedSubjectMapping,
        'encrypted subject mapping',
        32 * 1024
      );
      const mappingBytes = Buffer.from(encryptedSubjectMapping, 'base64url');
      if (mappingBytes.byteLength < 1 || mappingBytes.byteLength > 16_384) {
        throw new Error('Materialization key broker encrypted subject mapping is invalid');
      }
      const buyerSubjectPseudonym = requireBase64Url(
        response.buyerSubjectPseudonym,
        'buyer subject pseudonym',
        128
      );
      if (!SHA256_PATTERN.test(Buffer.from(buyerSubjectPseudonym, 'base64url').toString('hex'))) {
        throw new Error('Materialization key broker buyer subject pseudonym is invalid');
      }
      return {
        buyerSubjectPseudonym,
        encryptedSubjectMapping: Uint8Array.from(mappingBytes),
        pseudonymMethod: requireText(response.pseudonymMethod, 'pseudonym method', 128),
      };
    },
  };
}
