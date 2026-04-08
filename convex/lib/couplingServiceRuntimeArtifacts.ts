type RuntimeArtifactKey = 'coupling-runtime' | 'coupling-runtime-package';

type RuntimeArtifactManifestSuccess = {
  success: true;
  artifactKey: RuntimeArtifactKey;
  channel: string;
  platform: string;
  version: string;
  metadataVersion: number;
  deliveryName: string;
  contentType: string;
  envelopeCipher: string;
  envelopeIvBase64: string;
  ciphertextSha256: string;
  ciphertextSize: number;
  plaintextSha256: string;
  plaintextSize: number;
  codeSigningSubject?: string;
  codeSigningThumbprint?: string;
  downloadUrl: string;
};

export type RuntimeArtifactManifestResult =
  | RuntimeArtifactManifestSuccess
  | {
      success: false;
      error: string;
    };

function buildManifestUrl(baseUrl: string, artifactKey: RuntimeArtifactKey): string {
  return new URL(
    `v1/runtime-artifacts/manifest?artifactKey=${encodeURIComponent(artifactKey)}`,
    `${baseUrl.replace(/\/$/, '')}/`
  ).toString();
}

function readRequiredCouplingServiceBaseUrl(): string {
  const baseUrl = process.env.YUCP_COUPLING_SERVICE_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error('YUCP_COUPLING_SERVICE_BASE_URL is required');
  }
  return baseUrl;
}

function readRequiredCouplingServiceSecret(): string {
  const sharedSecret = process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new Error('YUCP_COUPLING_SERVICE_SHARED_SECRET is required');
  }
  return sharedSecret;
}

function isSuccessManifest(payload: unknown): payload is RuntimeArtifactManifestSuccess {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return (
    candidate.success === true &&
    typeof candidate.artifactKey === 'string' &&
    typeof candidate.channel === 'string' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.metadataVersion === 'number' &&
    typeof candidate.deliveryName === 'string' &&
    typeof candidate.contentType === 'string' &&
    typeof candidate.envelopeCipher === 'string' &&
    typeof candidate.envelopeIvBase64 === 'string' &&
    typeof candidate.ciphertextSha256 === 'string' &&
    typeof candidate.ciphertextSize === 'number' &&
    typeof candidate.plaintextSha256 === 'string' &&
    typeof candidate.plaintextSize === 'number' &&
    typeof candidate.downloadUrl === 'string'
  );
}

function isErrorManifest(payload: unknown): payload is { success: false; error: string } {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return candidate.success === false && typeof candidate.error === 'string';
}

export async function fetchRuntimeArtifactManifest(
  artifactKey: RuntimeArtifactKey
): Promise<RuntimeArtifactManifestResult> {
  let response: Response;
  try {
    response = await fetch(buildManifestUrl(readRequiredCouplingServiceBaseUrl(), artifactKey), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${readRequiredCouplingServiceSecret()}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (payload && typeof payload === 'object') {
      const errorMessage = (payload as { error?: { message?: string } }).error?.message?.trim();
      if (errorMessage) {
        return { success: false, error: errorMessage };
      }
    }
    return {
      success: false,
      error: `Coupling service manifest request failed with status ${response.status}`,
    };
  }

  if (isSuccessManifest(payload)) {
    return payload;
  }
  if (isErrorManifest(payload)) {
    return payload;
  }
  return {
    success: false,
    error: 'Coupling service returned an invalid runtime artifact manifest',
  };
}

export function buildRuntimeArtifactDownloadUrl(
  manifest: RuntimeArtifactManifestSuccess,
  token: string
): string {
  const url = new URL(manifest.downloadUrl);
  url.searchParams.set('token', token);
  return url.toString();
}
