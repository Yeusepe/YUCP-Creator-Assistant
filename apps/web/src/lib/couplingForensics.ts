import { ApiError, apiClient, apiFetch } from '@/api/client';

export interface CouplingForensicsMatchSummary {
  licenseSubject: string;
  assetPath: string;
  correlationId: string | null;
  createdAt: number;
  runtimeArtifactVersion?: string | null;
  runtimePlaintextSha256?: string | null;
}

export interface CouplingForensicsAssetResult {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  tokenLength: number;
  matched: boolean;
  matches: CouplingForensicsMatchSummary[];
}

export interface CouplingForensicsLookupResponse {
  packageId: string;
  message: string;
  candidateAssetCount: number;
  decodedAssetCount: number;
  results: CouplingForensicsAssetResult[];
}

export interface CouplingForensicsPackageList {
  packages: string[];
}

export async function listCouplingForensicsPackages() {
  return await apiClient.get<CouplingForensicsPackageList>('/api/forensics/packages');
}

export async function runCouplingForensicsLookup(args: { packageId: string; file: File }) {
  const formData = new FormData();
  formData.set('packageId', args.packageId);
  formData.set('file', args.file);
  return await apiFetch<CouplingForensicsLookupResponse>('/api/forensics/lookup', {
    method: 'POST',
    body: formData,
  });
}

export function isCouplingTraceabilityRequiredError(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 402) {
    return false;
  }
  const body =
    typeof error.body === 'object' && error.body !== null
      ? (error.body as { code?: unknown })
      : null;
  return body?.code === 'coupling_traceability_required';
}
