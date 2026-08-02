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
  attributionId?: string | null;
  buyerSubjectPseudonym?: string | null;
  assetPath: string;
  createdAt: number;
  runtimeArtifactVersion?: string | null;
  packFamily?: string | null;
  packVersion?: string | null;
  /** License store ('gumroad', 'jinxxy', etc.) */
  provider?: string | null;
  /** Non-secret license identifier (provider + short fingerprint). */
  licenseMasked?: string | null;
  /**
   * The buyer's actual license key. Only ever sent to the creator who owns the
   * package, who issued it in the first place.
   */
  licenseKey?: string | null;
  /** Provider + short fingerprint, shown when the raw key is unavailable. */
  licenseFingerprint?: string | null;
  /** Provider-native buyer account username, if known */
  buyerProviderUsername?: string | null;
  /** Linked Discord subject display name, if the buyer verified through the bot */
  buyerSubjectDisplayName?: string | null;
  /** Linked Discord account id, so the creator can act on the match */
  buyerSubjectDiscordUserId?: string | null;
}

export interface CouplingForensicsAssetResult {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  matched: boolean;
  layerBClassification:
    | 'trace-recovered'
    | 'tamper-suspected'
    | 'trace-likely-stripped'
    | 'unsupported-transform'
    | 'no-signal-found';
  matches: CouplingForensicsMatchSummary[];
}

/** One page of buyer candidates, as it was actually scored. */
export interface CouplingForensicsScanPage {
  page: number;
  buyersCompared: number;
  /** Assets whose trace was decoded on this page. */
  resolved: number;
  unresolvedAfter: number;
  /** Milliseconds from the start of the scan to the end of this page. */
  elapsedMs: number;
}

/** What the candidate scan actually did, so the verdict can be read in context. */
export interface CouplingForensicsScanSummary {
  /** False when the scan hit its time budget before exhausting the buyer list. */
  complete: boolean;
  durationMs: number;
  pagesScanned: number;
  requestedCandidateCount: number;
  candidateEvaluationCount: number;
  pages?: CouplingForensicsScanPage[];
}

export interface CouplingForensicsLookupResponse {
  packageId: string;
  lookupStatus:
    | 'attributed'
    | 'tampered_suspected'
    | 'hostile_unknown'
    | 'no_signal_found'
    | 'no_candidate_assets';
  message: string;
  candidateAssetCount: number;
  decodedAssetCount: number;
  results: CouplingForensicsAssetResult[];
  scan?: CouplingForensicsScanSummary;
}

export interface CouplingForensicsPackageList {
  packages: CouplingForensicsPackageSummary[];
}

export async function listCouplingForensicsPackages() {
  return await apiClient.get<CouplingForensicsPackageList>('/api/forensics/packages');
}

export interface CouplingForensicsLookupProgress {
  elapsedMs: number;
  pages: CouplingForensicsScanPage[];
}

type CouplingForensicsJobStatus =
  | { state: 'running'; progress: CouplingForensicsLookupProgress }
  | { state: 'done'; httpStatus: number; result: unknown };

const LOOKUP_JOB_POLL_INTERVAL_MS = 2_500;
/** Above the API's scan budget plus reveal budget, with margin for queueing. */
const LOOKUP_JOB_POLL_DEADLINE_MS = 10 * 60_000;
/** Transient poll failures a scan is allowed to ride out before giving up. */
const LOOKUP_JOB_POLL_MAX_CONSECUTIVE_FAILURES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A scan of a large buyer catalogue runs for minutes - longer than browsers
 * and edge proxies keep a single request open. The upload starts a server-side
 * job and the verdict is fetched by polling, so nothing on the path has to
 * survive the whole scan. Errors surface as the same ApiError the synchronous
 * route produced, so callers are unchanged.
 */
export async function runCouplingForensicsLookup(args: {
  packageId: string;
  file: File;
  onProgress?: (progress: CouplingForensicsLookupProgress) => void;
}) {
  const formData = new FormData();
  formData.set('packageId', args.packageId);
  formData.set('file', args.file);
  const { jobId } = await apiFetch<{ jobId: string }>('/api/forensics/lookup/jobs', {
    method: 'POST',
    body: formData,
  });

  const deadline = Date.now() + LOOKUP_JOB_POLL_DEADLINE_MS;
  let consecutiveFailures = 0;
  for (;;) {
    await sleep(LOOKUP_JOB_POLL_INTERVAL_MS);
    if (Date.now() > deadline) {
      throw new ApiError(504, { error: 'The scan did not finish in time' });
    }
    let status: CouplingForensicsJobStatus;
    try {
      status = await apiFetch<CouplingForensicsJobStatus>(`/api/forensics/lookup/jobs/${jobId}`);
      consecutiveFailures = 0;
    } catch (error) {
      // One dropped poll must not discard a scan that is still running.
      consecutiveFailures += 1;
      if (consecutiveFailures >= LOOKUP_JOB_POLL_MAX_CONSECUTIVE_FAILURES) {
        throw error;
      }
      continue;
    }
    if (status.state === 'running') {
      args.onProgress?.(status.progress);
      continue;
    }
    if (status.httpStatus < 200 || status.httpStatus >= 300) {
      throw new ApiError(status.httpStatus, status.result);
    }
    return status.result as CouplingForensicsLookupResponse;
  }
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
