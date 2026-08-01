import {
  Alert,
  Autocomplete,
  Button,
  Chip,
  Disclosure,
  Label,
  ListBox,
  SearchField,
  Table,
  useFilter,
} from '@heroui/react';
import { Stepper } from '@heroui-pro/react/stepper';
import { Timeline } from '@heroui-pro/react/timeline';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { DialogContext, Heading } from 'react-aria-components';
import { ApiError } from '@/api/client';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardGridSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { hasActiveCreatorBillingCapability, listCreatorCertificates } from '@/lib/certificates';
import {
  type CouplingForensicsAssetResult,
  type CouplingForensicsLookupResponse,
  isCouplingTraceabilityRequiredError,
  listCouplingForensicsPackages,
  runCouplingForensicsLookup,
} from '@/lib/couplingForensics';
import { BILLING_CAPABILITY_KEYS } from '../../../../../convex/lib/billingCapabilities';

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_FORENSICS_UPLOAD_BYTES = 100 * 1024 * 1024;
const SUPPORTED_FORENSICS_UPLOAD_EXTENSIONS = ['.unitypackage', '.zip'] as const;

function getForensicsFileValidationError(file: File): string | null {
  const normalizedName = file.name.trim().toLowerCase();
  const hasSupportedExtension = SUPPORTED_FORENSICS_UPLOAD_EXTENSIONS.some((extension) =>
    normalizedName.endsWith(extension)
  );
  if (!hasSupportedExtension) {
    return 'Unsupported file type. Upload a .unitypackage or .zip file.';
  }
  if (file.size > MAX_FORENSICS_UPLOAD_BYTES) {
    return 'File is too large. Maximum size is 100 MB.';
  }
  return null;
}

function formatBuyerDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function noRetryOn4xx(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function getVerdictKind(
  status: CouplingForensicsLookupResponse['lookupStatus'],
  buyerCount: number
): 'match' | 'trace_unresolved' | 'tampered' | 'no_signal' | 'no_match' | 'no_assets' {
  if (status === 'attributed' && buyerCount > 0) return 'match';
  if (status === 'attributed') return 'trace_unresolved';
  if (status === 'tampered_suspected') return 'tampered';
  if (status === 'no_signal_found') return 'no_signal';
  if (status === 'no_candidate_assets') return 'no_assets';
  return 'no_match';
}

function getBuyerDisplayLabel(match: {
  buyerSubjectDisplayName?: string | null;
  buyerProviderUsername?: string | null;
  licenseMasked?: string | null;
  buyerSubjectPseudonym?: string | null;
}) {
  const pseudonym = match.buyerSubjectPseudonym?.trim();
  return (
    match.buyerSubjectDisplayName?.trim() ||
    match.buyerProviderUsername?.trim() ||
    match.licenseMasked?.trim() ||
    (pseudonym ? `Buyer ${pseudonym.slice(0, 10)}` : null) ||
    null
  );
}

type FxTone = 'success' | 'warning' | 'info' | 'danger';

const VERDICT_CONFIG = {
  trace_unresolved: {
    tone: 'info',
    title: 'Trace found',
    description:
      "This file matches a traced license in your store, but we don't have the original buyer linked to that license yet.",
  },
  tampered: {
    tone: 'warning',
    title: 'Tracking removed',
    description:
      "This file was modified to remove identifying information. We can't trace it to a specific buyer, but the file was tampered with.",
  },
  no_signal: {
    tone: 'info',
    title: 'No tracking signal found',
    description:
      'The file has no valid buyer signal. It can be an original file, an older release, or a modified copy.',
  },
  no_assets: {
    tone: 'info',
    title: 'No trackable files found',
    description:
      "This archive doesn't contain any files that can be traced. Make sure you're uploading the right product.",
  },
  no_match: {
    tone: 'info',
    title: 'No match found',
    description:
      'This file doesn’t match any purchase in your store. It may have come from a different product or platform.',
  },
} as const;

function FxNoteIcon({ tone }: { tone: FxTone }) {
  if (tone === 'success') {
    return <Icon name="check" />;
  }
  if (tone === 'warning' || tone === 'danger') {
    return <Icon name="alert" />;
  }
  return <Icon name="info" />;
}

function FxNote({
  tone,
  title,
  description,
  children,
}: {
  tone: FxTone;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`fx-note fx-note--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="fx-note-icon" aria-hidden="true">
        <FxNoteIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="fx-note-title">{title}</p> : null}
        {description ? <p className="fx-note-desc">{description}</p> : null}
        {children}
      </div>
    </div>
  );
}

function MetaField({
  label,
  children,
  full,
  mono,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
  mono?: boolean;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <dt className="text-foreground/60 text-xs font-medium">{label}</dt>
      <dd
        className={`mt-0.5 text-foreground text-sm ${mono ? 'break-all font-mono text-[13px]' : ''}`}
      >
        {children}
      </dd>
    </div>
  );
}

const ASSET_CLASSIFICATION_LABEL: Record<
  CouplingForensicsAssetResult['layerBClassification'],
  { label: string; color: 'success' | 'danger' | 'warning' | 'default' }
> = {
  'trace-recovered': { color: 'success', label: 'Trace recovered' },
  'tamper-suspected': { color: 'danger', label: 'Tamper suspected' },
  'trace-likely-stripped': { color: 'warning', label: 'Trace stripped' },
  'unsupported-transform': { color: 'default', label: 'Unsupported' },
  'no-signal-found': { color: 'default', label: 'No signal' },
};

const SCAN_PHASES = [
  { description: 'Unpacking the archive and finding traceable files', title: 'Reading upload' },
  { description: 'Confirming you own this package', title: 'Checking access' },
  { description: 'Decoding traces against your buyer records', title: 'Comparing buyers' },
  { description: 'Resolving the licenses behind each match', title: 'Identifying licenses' },
] as const;

/**
 * Live phase progress while the lookup is in flight.
 *
 * The scan is one request with no intermediate reporting, so the step shown is
 * driven by elapsed time against the phases' measured shape: everything before
 * the buyer comparison is sub-second, and the comparison is what takes minutes.
 * It never claims to be finished, which the verdict does when it arrives.
 */
function ForensicsScanProgress({ startedAt }: { startedAt: number }) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const currentStep = elapsedMs < 700 ? 0 : elapsedMs < 1500 ? 1 : 2;

  return (
    <div className="fx-pane space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-foreground text-sm font-medium">Scanning</p>
        <span className="text-muted text-xs tabular-nums">
          {(elapsedMs / 1000).toFixed(0)}s elapsed
        </span>
      </div>
      <Stepper currentStep={currentStep} orientation="vertical" size="sm">
        {SCAN_PHASES.map((phase) => (
          <Stepper.Step key={phase.title}>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>{phase.title}</Stepper.Title>
              <Stepper.Description>{phase.description}</Stepper.Description>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
        ))}
      </Stepper>
      <p className="text-muted text-xs">
        Comparing buyers is the slow phase. Files with flat or near-flat colour carry no recoverable
        trace, so they are compared against every buyer before they can be ruled out.
      </p>
    </div>
  );
}

/**
 * What the scan looked at and how far it got.
 *
 * A verdict of "no match" means something different when the scan covered the
 * whole buyer list than when it stopped at its time budget, so the coverage is
 * reported next to the verdict rather than left implicit.
 */
function ForensicsScanReport({ result }: { result: CouplingForensicsLookupResponse }) {
  const { scan } = result;
  const stats: Array<{ label: string; value: string }> = [
    { label: 'Assets scanned', value: String(result.candidateAssetCount) },
    { label: 'Traces decoded', value: String(result.decodedAssetCount) },
    ...(scan
      ? [
          { label: 'Buyers compared', value: String(scan.requestedCandidateCount) },
          { label: 'Elapsed', value: `${(scan.durationMs / 1000).toFixed(1)}s` },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      {scan && !scan.complete ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Scan stopped early</Alert.Title>
            <Alert.Description>
              The scan reached its time budget after comparing {scan.requestedCandidateCount}{' '}
              buyers. Everything above is what it found so far, so a buyer further down the list
              would not appear yet.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <dl className="flex flex-wrap gap-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-surface-secondary flex items-baseline gap-2 rounded-lg px-3 py-2"
          >
            <dt className="text-muted text-xs">{stat.label}</dt>
            <dd className="text-foreground text-sm font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      {scan?.pages && scan.pages.length > 0 ? (
        <Disclosure>
          <Disclosure.Heading>
            <Button slot="trigger" variant="tertiary" size="sm">
              Scan log
              <Disclosure.Indicator />
            </Button>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-2">
              <Timeline>
                {scan.pages.map((page) => (
                  <Timeline.Item key={page.page} status={page.resolved > 0 ? 'success' : 'muted'}>
                    <Timeline.Rail>
                      <Timeline.Marker />
                      <Timeline.Connector />
                    </Timeline.Rail>
                    <Timeline.Content>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-4">
                        <p className="text-foreground text-sm font-medium">
                          Compared {page.buyersCompared} buyers
                        </p>
                        <span className="text-muted text-xs tabular-nums">
                          {(page.elapsedMs / 1000).toFixed(1)}s
                        </span>
                        {page.resolved > 0 ? (
                          <Chip color="success" variant="soft" size="sm">
                            <Chip.Label>
                              {page.resolved} trace{page.resolved === 1 ? '' : 's'} decoded
                            </Chip.Label>
                          </Chip>
                        ) : (
                          <span className="text-muted text-xs">
                            {page.unresolvedAfter} file
                            {page.unresolvedAfter === 1 ? '' : 's'} still unidentified
                          </span>
                        )}
                      </div>
                    </Timeline.Content>
                  </Timeline.Item>
                ))}
              </Timeline>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}

      {result.results.length > 0 ? (
        <Disclosure>
          <Disclosure.Heading>
            <Button slot="trigger" variant="tertiary" size="sm">
              Per-file detail
              <Disclosure.Indicator />
            </Button>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-2">
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="Per-file scan results">
                    <Table.Header>
                      <Table.Column isRowHeader>File</Table.Column>
                      <Table.Column>Result</Table.Column>
                      <Table.Column>License</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {result.results.map((assetResult) => {
                        const classification =
                          ASSET_CLASSIFICATION_LABEL[assetResult.layerBClassification];
                        // Which licence this individual file traces to, so a
                        // multi-buyer archive shows per-file provenance rather
                        // than one verdict for the whole upload.
                        const licenses = [
                          ...new Set(
                            assetResult.matches
                              .map((match) => match.licenseMasked?.trim())
                              .filter((license): license is string => Boolean(license))
                          ),
                        ];
                        return (
                          <Table.Row key={assetResult.assetPath}>
                            <Table.Cell className="font-mono text-xs break-all">
                              {assetResult.assetPath}
                            </Table.Cell>
                            <Table.Cell>
                              <Chip color={classification.color} variant="soft" size="sm">
                                <Chip.Label>{classification.label}</Chip.Label>
                              </Chip>
                            </Table.Cell>
                            <Table.Cell className="font-mono text-xs break-all tabular-nums">
                              {licenses.length > 0 ? licenses.join(', ') : '—'}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}
    </div>
  );
}

export function CouplingForensicsPanel({ initialPackageId }: { initialPackageId?: string } = {}) {
  const toast = useToast();
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();
  const { contains } = useFilter({ sensitivity: 'base' });

  const [selectedPackageId, setSelectedPackageId] = useState(initialPackageId ?? '');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CouplingForensicsLookupResponse | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const handleFilePick = (file: File | null): boolean => {
    if (lookupMutation.isPending) return false;
    if (!file) {
      setSelectedFile(null);
      setInlineError(null);
      setLookupResult(null);
      return true;
    }
    const validationError = getForensicsFileValidationError(file);
    if (validationError) {
      setSelectedFile(null);
      setInlineError(validationError);
      setLookupResult(null);
      return false;
    }
    setSelectedFile(file);
    setInlineError(null);
    setLookupResult(null);
    return true;
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer.files[0] ?? null;
    if (file) handleFilePick(file);
  };

  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries && isPersonalDashboard,
    retry: noRetryOn4xx,
  });

  const capabilityEnabled = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.couplingTraceability
  );

  const packagesQuery = useQuery({
    queryKey: ['coupling-forensics', 'packages'],
    queryFn: listCouplingForensicsPackages,
    enabled: canRunPanelQueries && isPersonalDashboard && capabilityEnabled,
    retry: noRetryOn4xx,
  });

  useEffect(() => {
    if (
      isDashboardAuthError(packagesQuery.error) ||
      isDashboardAuthError(certificatesQuery.error)
    ) {
      markSessionExpired();
    }
  }, [certificatesQuery.error, markSessionExpired, packagesQuery.error]);

  const packageOptions = useMemo(
    () =>
      (packagesQuery.data?.packages ?? []).map((pkg) => ({
        value: pkg.packageId,
        label: pkg.packageName ?? pkg.packageId,
      })),
    [packagesQuery.data?.packages]
  );

  useEffect(() => {
    if (packageOptions.length === 0) {
      if (selectedPackageId) setSelectedPackageId('');
      return;
    }
    if (!packageOptions.some((option) => option.value === selectedPackageId)) {
      setSelectedPackageId(packageOptions[0]?.value ?? '');
    }
  }, [packageOptions, selectedPackageId]);

  // Collect all matches across all matched assets, deduplicated by opaque buyer/license id.
  const matchedBuyers = useMemo(() => {
    if (!lookupResult) return [];
    const seen = new Set<string>();
    const buyers: Array<{
      buyerMatchId: string;
      createdAt: number;
      packFamily?: string | null;
      packVersion?: string | null;
      provider?: string | null;
      licenseMasked?: string | null;
      buyerProviderUsername?: string | null;
      buyerSubjectDisplayName?: string | null;
      buyerSubjectPseudonym?: string | null;
      buyerDisplayLabel: string;
    }> = [];
    for (const entry of lookupResult.results) {
      if (!entry.matched) continue;
      for (const match of entry.matches) {
        const buyerDisplayLabel = getBuyerDisplayLabel(match);
        if (!buyerDisplayLabel) continue;
        const buyerMatchId = match.buyerMatchId?.trim() || match.matchId;
        if (!seen.has(buyerMatchId)) {
          seen.add(buyerMatchId);
          buyers.push({
            buyerMatchId,
            createdAt: match.createdAt,
            packFamily: match.packFamily,
            packVersion: match.packVersion,
            provider: match.provider,
            licenseMasked: match.licenseMasked,
            buyerProviderUsername: match.buyerProviderUsername,
            buyerSubjectDisplayName: match.buyerSubjectDisplayName,
            buyerSubjectPseudonym: match.buyerSubjectPseudonym,
            buyerDisplayLabel,
          });
        }
      }
    }
    return buyers.sort((a, b) => b.createdAt - a.createdAt);
  }, [lookupResult]);

  const lookupMutation = useMutation({
    mutationFn: ({ packageId, file }: { packageId: string; file: File }) =>
      runCouplingForensicsLookup({ packageId, file }),
    onMutate: () => {
      setInlineError(null);
      setLookupResult(null);
      setScanStartedAt(Date.now());
    },
    onSuccess: (result) => {
      setLookupResult(result);
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      if (isCouplingTraceabilityRequiredError(error)) {
        toast.warning('Creator Studio+ required', {
          description: 'Upgrade your creator workspace to use leak tracing.',
        });
        return;
      }
      setInlineError('We couldn’t scan that file. Try a .unitypackage or .zip file.');
    },
  });

  const isLoading =
    !isAuthResolved || (canRunPanelQueries && isPersonalDashboard && certificatesQuery.isLoading);
  const hasCapabilityQueryError =
    certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error);
  const hasQueryError = packagesQuery.isError && !isDashboardAuthError(packagesQuery.error);

  const verdictKind = lookupResult
    ? getVerdictKind(lookupResult.lookupStatus, matchedBuyers.length)
    : null;

  /* ── Guards ── */

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div className="dashboard-tab-panel is-active">
        <DashboardAuthRequiredState
          id="forensics-auth"
          title="Sign in to trace leaked files"
          description="Your session expired. Sign in again to identify who shared your product."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div className="dashboard-tab-panel is-active">
        <div className="bento-grid">
          <section className="intg-card animate-in bento-col-12">
            <div className="intg-header">
              <div className="intg-icon">
                <Icon name="shield" size={22} />
              </div>
              <div className="intg-copy">
                <h1 className="intg-title">Creator scope required</h1>
                <p className="intg-desc">
                  Leak tracing is scoped to your Creator Identity. Open it from your root creator
                  dashboard.
                </p>
              </div>
            </div>
            <Link
              to="/dashboard/packages"
              search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
              className="account-btn account-btn--primary"
              style={{ borderRadius: '999px', alignSelf: 'flex-start' }}
            >
              Switch to creator dashboard
            </Link>
          </section>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="dashboard-tab-panel is-active">
        <div className="bento-grid">
          <DashboardGridSkeleton cards={3} />
        </div>
      </div>
    );
  }

  /* ── Main ── */

  return (
    <div className="dashboard-tab-panel is-active">
      <div className="bento-grid">
        <section className="intg-card animate-in bento-col-12">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <Icon name="leakTrace" size={18} />
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Leak Tracer</h2>
                <p className="intg-desc">
                  Found a suspicious file? Upload it to find out which buyer it came from.
                </p>
              </div>
            </div>
            <Chip variant="soft" size="sm" className="text-foreground/60">
              Creator Studio+
            </Chip>
          </div>
          <div className="mt-5 space-y-5">
            {hasQueryError ? (
              <FxNote
                tone="danger"
                title="Couldn’t load your products"
                description="Refresh the page and try again."
              />
            ) : null}
            {inlineError ? <FxNote tone="danger" description={inlineError} /> : null}

            {hasCapabilityQueryError ? (
              <FxNote
                tone="warning"
                title="We couldn’t verify your plan"
                description="Refresh your billing state and try again."
              >
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-3 w-fit"
                  onPress={() => {
                    void certificatesQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </FxNote>
            ) : certificatesQuery.isSuccess && capabilityEnabled === false ? (
              <FxNote
                tone="info"
                title="Creator Studio+ required"
                description="Leak tracing is available on Creator Studio+. Upgrade to identify buyers who share your files."
              >
                <Link
                  to="/account/billing"
                  className="account-btn account-btn--primary mt-3"
                  style={{ borderRadius: '999px', alignSelf: 'flex-start' }}
                >
                  Upgrade billing
                </Link>
              </FxNote>
            ) : (
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!selectedPackageId || !selectedFile) {
                    setInlineError('Choose a product and upload a file to scan.');
                    return;
                  }
                  const validationError = getForensicsFileValidationError(selectedFile);
                  if (validationError) {
                    setSelectedFile(null);
                    setInlineError(validationError);
                    return;
                  }
                  lookupMutation.mutate({ packageId: selectedPackageId, file: selectedFile });
                }}
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent text-accent-foreground flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                      1
                    </span>
                    <span className="text-foreground text-sm font-medium">
                      Which product is this file from?
                    </span>
                  </div>
                  <Autocomplete
                    className="pm-package-picker w-full max-w-md"
                    placeholder="Choose a product"
                    selectionMode="single"
                    isDisabled={lookupMutation.isPending || packageOptions.length === 0}
                    value={selectedPackageId || null}
                    onChange={(key) => {
                      setSelectedPackageId(key ? String(key) : '');
                      setLookupResult(null);
                    }}
                    onClear={() => {
                      setSelectedPackageId('');
                      setLookupResult(null);
                    }}
                  >
                    <Label className="sr-only">Product to scan</Label>
                    <Autocomplete.Trigger>
                      <Autocomplete.Value />
                      <Autocomplete.ClearButton />
                      <Autocomplete.Indicator />
                    </Autocomplete.Trigger>
                    <DialogContext.Provider value={{ 'aria-label': 'Choose a product to scan' }}>
                      <Autocomplete.Popover className="pm-package-picker-popover">
                        <Heading className="sr-only" slot="title">
                          Choose a product to scan
                        </Heading>
                        <Autocomplete.Filter filter={contains}>
                          <SearchField
                            autoFocus
                            name="forensics-product-search"
                            variant="secondary"
                          >
                            <Label className="sr-only">Search products</Label>
                            <SearchField.Group>
                              <SearchField.SearchIcon />
                              <SearchField.Input
                                aria-label="Search products"
                                placeholder="Search products..."
                              />
                              <SearchField.ClearButton />
                            </SearchField.Group>
                          </SearchField>
                          <ListBox
                            aria-label="Products available to scan"
                            renderEmptyState={() => (
                              <div className="pm-subtle-copy px-3 py-2 text-sm">
                                No products match that search.
                              </div>
                            )}
                          >
                            {packageOptions.map((option) => (
                              <ListBox.Item
                                key={option.value}
                                id={option.value}
                                textValue={option.label}
                              >
                                {option.label}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Autocomplete.Filter>
                      </Autocomplete.Popover>
                    </DialogContext.Provider>
                  </Autocomplete>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent text-accent-foreground flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                      2
                    </span>
                    <span className="text-foreground text-sm font-medium">
                      Upload the suspicious file
                    </span>
                  </div>
                  {selectedFile ? (
                    <div className="fx-pane flex items-center gap-3 p-4">
                      <span className="fx-icon-chip text-foreground/60 flex size-10 shrink-0 items-center justify-center rounded-xl">
                        <Icon name="auditLog" size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm font-medium">
                          {selectedFile.name}
                        </p>
                        <p className="text-foreground/60 text-xs tabular-nums">
                          {formatFileSize(selectedFile.size)}
                        </p>
                      </div>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label="Remove file"
                        isDisabled={lookupMutation.isPending}
                        onPress={() => {
                          if (lookupMutation.isPending) return;
                          handleFilePick(null);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}
                      >
                        <Icon name="close" size={14} />
                      </Button>
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        disabled={lookupMutation.isPending}
                        className="hidden"
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          if (!handleFilePick(e.target.files?.[0] ?? null)) {
                            e.currentTarget.value = '';
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <label
                      htmlFor="forensics-file"
                      onDragEnter={handleDragEnter}
                      onDragOver={(e) => e.preventDefault()}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`fx-dropzone flex cursor-[var(--cursor-interactive)] flex-col items-center justify-center gap-2 p-8 text-center ${
                        isDragOver ? 'is-dragover' : ''
                      } ${lookupMutation.isPending ? 'pointer-events-none opacity-60' : ''}`}
                    >
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        className="sr-only"
                        disabled={lookupMutation.isPending}
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          if (!handleFilePick(e.target.files?.[0] ?? null)) {
                            e.currentTarget.value = '';
                          }
                        }}
                      />
                      <span className="fx-icon-chip text-foreground/60 flex size-11 items-center justify-center rounded-full">
                        <Icon name="upload" size={20} />
                      </span>
                      <p className="text-foreground text-sm font-medium">
                        {isDragOver ? 'Drop to upload' : 'Click to upload or drag & drop'}
                      </p>
                      <p className="text-foreground/60 text-xs">
                        .unitypackage or .zip · max 100 MB
                      </p>
                    </label>
                  )}
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={lookupMutation.isPending}
                    isDisabled={
                      lookupMutation.isPending ||
                      !selectedPackageId ||
                      !selectedFile ||
                      packageOptions.length === 0
                    }
                  >
                    {lookupMutation.isPending ? 'Scanning…' : 'Find buyer'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* Live scan progress, replaced by the verdict when it lands */}
        {lookupMutation.isPending && scanStartedAt ? (
          <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
            <ForensicsScanProgress startedAt={scanStartedAt} />
          </section>
        ) : null}

        {/* Results */}
        {lookupResult && verdictKind ? (
          <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
            <div className="space-y-4">
              {verdictKind === 'match' ? (
                <>
                  <Alert status="success">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>
                        {matchedBuyers.length === 1
                          ? 'Buyer identified'
                          : `${matchedBuyers.length} buyers identified`}
                      </Alert.Title>
                      <Alert.Description>
                        {matchedBuyers.length === 1
                          ? 'This file traces back to the license below.'
                          : 'This file traces back to the licenses below.'}
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                  <div className="space-y-3">
                    {matchedBuyers.map((buyer) => (
                      <div key={buyer.buyerMatchId} className="fx-pane space-y-4 p-4">
                        {/* The license is the answer this whole panel exists to
                            produce, so it leads rather than trailing a meta list. */}
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <p className="text-muted text-xs">License</p>
                            {buyer.licenseMasked ? (
                              <p className="text-foreground font-mono text-base font-semibold tabular-nums break-all">
                                {buyer.licenseMasked}
                              </p>
                            ) : (
                              <p className="text-muted text-base">Not recorded for this purchase</p>
                            )}
                          </div>
                          {buyer.provider ? (
                            <Chip color="success" variant="soft">
                              <Chip.Label className="capitalize">{buyer.provider}</Chip.Label>
                            </Chip>
                          ) : null}
                        </div>
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                          <MetaField label="Buyer">{buyer.buyerDisplayLabel}</MetaField>
                          {buyer.buyerProviderUsername &&
                          buyer.buyerProviderUsername !== buyer.buyerDisplayLabel ? (
                            <MetaField label="Store account">
                              {buyer.buyerProviderUsername}
                            </MetaField>
                          ) : null}
                          <MetaField label="Trace recorded">
                            {formatBuyerDate(buyer.createdAt)}
                          </MetaField>
                        </dl>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Alert
                  status={VERDICT_CONFIG[verdictKind].tone === 'warning' ? 'warning' : 'default'}
                >
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{VERDICT_CONFIG[verdictKind].title}</Alert.Title>
                    <Alert.Description>{VERDICT_CONFIG[verdictKind].description}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              <ForensicsScanReport result={lookupResult} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
