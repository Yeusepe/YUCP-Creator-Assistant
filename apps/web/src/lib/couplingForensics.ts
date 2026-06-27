import { ApiError, apiClient, apiFetch } from '@/api/client';

export interface CouplingForensicsPackageSummary {
  packageId: string;
  packageName?: string;
  registeredAt: number;
  updatedAt: number;
}

export interface CouplingForensicsMatchSummary {
  matchId: string;
  buyerMatchId?: string | null;
  assetPath: string;
  createdAt: number;
  runtimeArtifactVersion?: string | null;
  packFamily?: string | null;
  packVersion?: string | null;
  /** License store ('gumroad', 'jinxxy', etc.) */
  provider?: string | null;
  /** Non-secret license identifier (provider + short fingerprint). */
  licenseMasked?: string | null;
  /** Provider-native buyer account username, if known */
  buyerProviderUsername?: string | null;
  /** Linked Discord subject display name, if the buyer verified through the bot */
  buyerSubjectDisplayName?: string | null;
}

export interface CouplingForensicsAssetResult {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  tokenLength: number;
  matched: boolean;
  classification: 'attributed' | 'hostile_unknown';
  matches: CouplingForensicsMatchSummary[];
}

export interface CouplingForensicsLookupResponse {
  packageId: string;
  lookupStatus: 'attributed' | 'tampered_suspected' | 'hostile_unknown' | 'no_candidate_assets';
  message: string;
  candidateAssetCount: number;
  decodedAssetCount: number;
  results: CouplingForensicsAssetResult[];
}

export interface CouplingForensicsPackageList {
  packages: CouplingForensicsPackageSummary[];
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
