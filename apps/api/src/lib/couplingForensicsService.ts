import { readFile } from 'node:fs/promises';
import type { ExtractedForensicsAsset } from './couplingForensicsArchives';

export type CouplingForensicsServiceConfig = {
  baseUrl: string;
  sharedSecret: string;
};

export type CouplingForensicsFinding = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  tokenHex: string;
  tokenLength: number;
};

export type ForensicPreclassification = 'decoded' | 'likely-stripped' | 'no-signal';

export type ForensicsScoreResult = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  preclassification: ForensicPreclassification;
  tokenHex?: string;
  tokenLength?: number;
  nativeCode?: number;
  decodeError?: string;
};

type CouplingServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    decoderKind?: string;
    tokenHex?: string;
    tokenLength?: number;
  }>;
};

type ForensicScoreServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  requestId?: string;
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    decoderKind?: string;
    preclassification?: string;
    tokenHex?: string;
    tokenLength?: number;
    nativeCode?: number;
    decodeError?: string;
  }>;
};

const HEX_RE = /^[0-9a-f]+$/;

export class CouplingServiceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouplingServiceConfigurationError';
  }
}

export class CouplingServiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'CouplingServiceRequestError';
  }
}

function normalizeAssetType(value: string): 'png' | 'fbx' {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'png' && normalized !== 'fbx') {
    throw new CouplingServiceRequestError(`Unsupported coupling scan asset type: ${value}`, 502);
  }
  return normalized;
}

function buildCouplingScanUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedBaseUrl) {
    throw new CouplingServiceConfigurationError('Coupling service base URL is not configured');
  }
  return new URL('v1/coupling/scan', `${normalizedBaseUrl.replace(/\/$/, '')}/`).toString();
}

function validateCouplingScanResult(
  input: ExtractedForensicsAsset[],
  payload: CouplingServiceResponse
): CouplingForensicsFinding[] {
  const assetByPath = new Map(input.map((entry) => [entry.assetPath, entry]));
  const results = payload.results ?? [];
  return results.map((entry) => {
    const assetPath = entry.assetPath?.trim() || '';
    const tokenHex = entry.tokenHex?.trim().toLowerCase() || '';
    const tokenLength = Number(entry.tokenLength ?? 0);
    const inputEntry = assetByPath.get(assetPath);
    if (!inputEntry) {
      throw new CouplingServiceRequestError(
        `Coupling service returned an unknown asset path: ${assetPath || '[missing]'}`,
        502
      );
    }
    if (!tokenHex || !HEX_RE.test(tokenHex)) {
      throw new CouplingServiceRequestError(
        `Coupling service returned an invalid token for ${assetPath}`,
        502
      );
    }
    if (tokenLength <= 0 || tokenHex.length !== tokenLength) {
      throw new CouplingServiceRequestError(
        `Coupling service token length mismatch for ${assetPath}`,
        502
      );
    }
    return {
      assetPath,
      assetType: normalizeAssetType(entry.assetType || inputEntry.assetType),
      decoderKind: entry.decoderKind?.trim() || inputEntry.assetType,
      tokenHex,
      tokenLength,
    };
  });
}

async function buildRequestBody(assets: ExtractedForensicsAsset[]): Promise<string> {
  const serializedAssets = await Promise.all(
    assets.map(async (asset) => ({
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      contentBase64: Buffer.from(await readFile(asset.filePath)).toString('base64'),
    }))
  );

  return JSON.stringify({
    mode: 'scan',
    assets: serializedAssets,
  });
}

function parseResponsePayload(responseText: string): CouplingServiceResponse | null {
  if (!responseText.trim()) {
    return {};
  }

  try {
    return JSON.parse(responseText) as CouplingServiceResponse;
  } catch {
    return null;
  }
}

function extractCouplingServiceErrorDetail(
  payload:
    | {
        error?:
          | string
          | {
              code?: unknown;
              message?: unknown;
            };
      }
    | null
    | undefined,
  responseText: string,
  statusText: string
): string {
  const rawError = payload?.error;
  if (typeof rawError === 'string') {
    return rawError.trim() || responseText.trim() || statusText.trim();
  }
  if (rawError && typeof rawError === 'object') {
    const message = typeof rawError.message === 'string' ? rawError.message.trim() : '';
    if (message) {
      return message;
    }
    const code = typeof rawError.code === 'string' ? rawError.code.trim() : '';
    if (code) {
      return code;
    }
  }
  return responseText.trim() || statusText.trim();
}

function buildForensicScoreUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedBaseUrl) {
    throw new CouplingServiceConfigurationError('Coupling service base URL is not configured');
  }
  return new URL(
    'v1/coupling/forensic-score',
    `${normalizedBaseUrl.replace(/\/$/, '')}/`
  ).toString();
}

function validateForensicsScoreResult(
  input: ExtractedForensicsAsset[],
  payload: ForensicScoreServiceResponse
): ForensicsScoreResult[] {
  const assetByPath = new Map(input.map((entry) => [entry.assetPath, entry]));
  const results = payload.results ?? [];
  const validatedResults = new Map<string, ForensicsScoreResult>();

  for (const entry of results) {
    const assetPath = entry.assetPath?.trim() || '';
    const inputEntry = assetByPath.get(assetPath);
    if (!inputEntry) {
      throw new CouplingServiceRequestError(
        `Coupling service returned an unknown asset path: ${assetPath || '[missing]'}`,
        502
      );
    }
    if (validatedResults.has(assetPath)) {
      throw new CouplingServiceRequestError(
        `Coupling service returned a duplicate asset path: ${assetPath}`,
        502
      );
    }

    const preclassificationRaw = entry.preclassification?.trim() ?? '';
    const preclassification: ForensicPreclassification =
      preclassificationRaw === 'decoded' ||
      preclassificationRaw === 'likely-stripped' ||
      preclassificationRaw === 'no-signal'
        ? (preclassificationRaw as ForensicPreclassification)
        : 'no-signal';

    const result: ForensicsScoreResult = {
      assetPath,
      assetType: normalizeAssetType(entry.assetType || inputEntry.assetType),
      decoderKind: entry.decoderKind?.trim() || inputEntry.assetType,
      preclassification,
    };

    if (preclassification === 'decoded' && entry.tokenHex) {
      const tokenHex = entry.tokenHex.trim().toLowerCase();
      const tokenLength = Number(entry.tokenLength ?? 0);
      if (HEX_RE.test(tokenHex) && tokenLength > 0 && tokenHex.length === tokenLength) {
        result.tokenHex = tokenHex;
        result.tokenLength = tokenLength;
      }
    }

    if (entry.nativeCode !== undefined) {
      result.nativeCode = entry.nativeCode;
    }

    if (entry.decodeError) {
      result.decodeError = entry.decodeError.trim();
    }

    validatedResults.set(assetPath, result);
  }

  return input.map((asset) => {
    const existing = validatedResults.get(asset.assetPath);
    if (existing) {
      return existing;
    }
    return {
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      decoderKind: asset.assetType,
      preclassification: 'no-signal',
    };
  });
}

export async function runCouplingForensicsScore(
  assets: ExtractedForensicsAsset[],
  config: CouplingForensicsServiceConfig
): Promise<ForensicsScoreResult[]> {
  if (assets.length === 0) {
    return [];
  }

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  let response: Response;
  try {
    response = await fetch(buildForensicScoreUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: await buildRequestBody(assets),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouplingServiceRequestError(`Coupling service is unreachable: ${message}`, 503);
  }

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText) as ForensicScoreServiceResponse | null;

  if (!response.ok) {
    const detail = extractCouplingServiceErrorDetail(payload, responseText, response.statusText);
    throw new CouplingServiceRequestError(
      `Coupling forensic-score failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  if (!payload) {
    throw new CouplingServiceRequestError(
      'Coupling service returned invalid JSON',
      response.status
    );
  }

  return validateForensicsScoreResult(assets, payload);
}

export async function runCouplingForensicsScan(
  assets: ExtractedForensicsAsset[],
  config: CouplingForensicsServiceConfig
): Promise<CouplingForensicsFinding[]> {
  if (assets.length === 0) {
    return [];
  }

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  let response: Response;
  try {
    response = await fetch(buildCouplingScanUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: await buildRequestBody(assets),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouplingServiceRequestError(`Coupling service is unreachable: ${message}`, 503);
  }

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText);

  if (!response.ok) {
    const detail = extractCouplingServiceErrorDetail(payload, responseText, response.statusText);
    throw new CouplingServiceRequestError(
      `Coupling service scan failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  if (!payload) {
    throw new CouplingServiceRequestError(
      'Coupling service returned invalid JSON',
      response.status
    );
  }

  return validateCouplingScanResult(assets, payload);
}
