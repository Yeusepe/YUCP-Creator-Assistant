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

type CouplingServiceResponse = {
  error?: string;
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    decoderKind?: string;
    tokenHex?: string;
    tokenLength?: number;
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

  const response = await fetch(buildCouplingScanUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${sharedSecret}`,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
    body: await buildRequestBody(assets),
  });

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText);

  if (!response.ok) {
    const detail = payload?.error?.trim() || responseText.trim() || response.statusText.trim();
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
