import { ApiError, apiClient, apiFetch } from '@/api/client';

export interface CouplingForensicsPackageSummary {
  packageId: string;
  packageName?: string;
  registeredAt: number;
  updatedAt: number;
}

export interface CouplingForensicsMatchSummary {
  licenseSubject: string;
  assetPath: string;
  correlationId: string | null;
  createdAt: number;
  runtimeArtifactVersion?: string | null;
  runtimePlaintextSha256?: string | null;
  machineFingerprintHash?: string | null;
  projectIdHash?: string | null;
  grantId?: string | null;
  packFamily?: string | null;
  packVersion?: string | null;
  /** License store ('gumroad', 'jinxxy', etc.) */
  provider?: string | null;
  /** Non-secret license identifier (provider + short fingerprint). Full key via reveal. */
  licenseMasked?: string | null;
  /** Buyer's email address from the provider API */
  purchaserEmail?: string | null;
  /** Raw license key used to verify the purchase */
  licenseKey?: string | null;
  /** Provider-native buyer account identifier */
  buyerProviderUserId?: string | null;
  /** Provider-native buyer account username, if known */
  buyerProviderUsername?: string | null;
  /** Linked Discord subject display name, if the buyer verified through the bot */
  buyerSubjectDisplayName?: string | null;
  /** Linked Discord subject id, if the buyer verified through the bot */
  buyerSubjectDiscordUserId?: string | null;
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

export interface CouplingForensicsRevealResponse {
  licenseKey?: string | null;
}

/**
 * Reveals the full provider license key behind a forensics match. Privileged + audit-logged
 * server-side; only call from an explicit user action (e.g. a "Reveal" button).
 */
export async function revealCouplingLicenseKey(args: {
  packageId: string;
  licenseSubject: string;
}) {
  return await apiFetch<CouplingForensicsRevealResponse>('/api/forensics/reveal-license', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: args.packageId, licenseSubject: args.licenseSubject }),
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
