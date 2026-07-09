import { createHash } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { gunzipSync, unzipSync } from 'fflate';
import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { api } from '../convex/_generated/api';
import { createServiceActorBinding } from '../convex/lib/apiActor';

type ConvexClient = {
  query: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  mutation: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

type CatalogProduct = {
  _id: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  status: string;
};

type BuyerAccessContext = {
  catalogProductId: string;
  creatorAuthUserId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  status: string;
  backstagePackages: Array<{
    packageId: string;
    packageName?: string;
    displayName?: string;
    latestPublishedVersion?: string;
    repositoryVisibility?: string;
  }>;
};

type Entitlement = {
  id: string;
  subjectId: string;
  productId: string;
  sourceProvider: string;
  sourceReference: string;
  catalogProductId?: string;
  status: string;
};

type RepoPackage = {
  displayName: string;
  headers: Record<string, string>;
  manifest: Record<string, unknown>;
  packageId: string;
  url: string;
  version: string;
};

type ResolvedPackageDownload = {
  cdngineDelivery?: {
    assetId: string;
    deliveryScopeId: string;
    variant: string;
    versionId: string;
  };
  channel: string;
  contentType?: string;
  deliveryArtifactId?: string;
  deliveryName: string;
  downloadUrl: string;
  version: string;
  zipSha256?: string;
};

type ResolvedRawPackageDownload = {
  cdngineSource?: {
    assetId: string;
    assetOwner: string;
    byteSize: number;
    serviceNamespaceId: string;
    sha256: string;
    tenantId: string;
    uploadedAt: number;
    versionId: string;
  };
  channel: string;
  contentType: string;
  deliveryArtifactId: string;
  deliveryName: string;
  downloadUrl: string;
  packageSha256: string;
  sourceKind: 'zip' | 'unitypackage';
  version: string;
};

type Config = {
  apiBaseUrl: string;
  attempts: number;
  catalogProductId?: string;
  creatorAuthUserId: string;
  ensureSmokeEntitlement: boolean;
  intervalMs: number;
  packageId: string;
  version?: string;
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length).trim() || undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function readConfig(): Config {
  const attempts = Number.parseInt(readArg('attempts') ?? '120', 10);
  const intervalMs = Number.parseInt(readArg('intervalMs') ?? '1000', 10);
  return {
    apiBaseUrl: (readArg('apiBaseUrl') ?? process.env.API_BASE_URL ?? 'http://localhost:3001')
      .trim()
      .replace(/\/+$/, ''),
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 120,
    catalogProductId: readArg('catalogProductId'),
    creatorAuthUserId:
      readArg('creatorAuthUserId') ?? 'k579z1ksztymey9wcs1hps4w85827d4e',
    ensureSmokeEntitlement: !hasFlag('noEnsureSmokeEntitlement'),
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 1000,
    packageId: readArg('packageId') ?? 'com.yucp.songthing',
    version: readArg('version') ?? '1.0.12',
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function flattenRepoPackages(
  repository: unknown,
  inheritedHeaders: Record<string, string>
): RepoPackage[] {
  if (!isRecord(repository) || !isRecord(repository.packages)) {
    throw new Error('Repository document is missing a packages map.');
  }

  const packages: RepoPackage[] = [];
  for (const [packageId, packageEntry] of Object.entries(repository.packages)) {
    if (!isRecord(packageEntry) || !isRecord(packageEntry.versions)) {
      continue;
    }

    for (const [version, manifestValue] of Object.entries(packageEntry.versions)) {
      if (!isRecord(manifestValue) || typeof manifestValue.url !== 'string') {
        continue;
      }
      const displayName =
        typeof manifestValue.displayName === 'string' && manifestValue.displayName.trim()
          ? manifestValue.displayName.trim()
          : packageId;
      packages.push({
        displayName,
        headers: {
          ...inheritedHeaders,
          ...getHeaders(manifestValue.headers),
        },
        manifest: manifestValue,
        packageId,
        url: manifestValue.url,
        version,
      });
    }
  }
  return packages;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readResponseSnippet(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

async function describeDeliveryAuthorization(input: {
  client: ConvexClient;
  apiSecret: string;
  config: Config;
  repoPackage: RepoPackage;
  subjectId: string;
  tokenHash: string;
}): Promise<string> {
  const packageUrl = new URL(input.repoPackage.url);
  const channel = packageUrl.searchParams.get('channel') ?? 'stable';
  const resolved = (await input.client.query(api.backstageRepos.resolvePackageDownloadForApi, {
    apiSecret: input.apiSecret,
    tokenHash: input.tokenHash,
    authUserId: input.config.creatorAuthUserId,
    channel,
    packageId: input.config.packageId,
    subjectId: input.subjectId,
    version: input.repoPackage.version,
  })) as ResolvedPackageDownload | null;

  if (!resolved) {
    return 'Convex resolvePackageDownloadForApi returned null.';
  }
  if (!resolved.cdngineDelivery) {
    return `Convex resolved a package without CDNgine delivery coordinates. deliveryName=${resolved.deliveryName}`;
  }

  const cdngineBaseUrl = (
    process.env.CDNGINE_API_BASE_URL ??
    process.env.CDNGINE_PUBLIC_API_BASE_URL ??
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const cdngineToken = (process.env.CDNGINE_ACCESS_TOKEN ?? process.env.CDNGINE_API_TOKEN ?? '')
    .trim();
  const coordinates = `asset=${resolved.cdngineDelivery.assetId} version=${resolved.cdngineDelivery.versionId} scope=${resolved.cdngineDelivery.deliveryScopeId} variant=${resolved.cdngineDelivery.variant}`;
  if (!cdngineBaseUrl || !cdngineToken) {
    return `${coordinates}. CDNgine API env is not available in this process.`;
  }

  const authorizationUrl = `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(
    resolved.cdngineDelivery.assetId
  )}/versions/${encodeURIComponent(
    resolved.cdngineDelivery.versionId
  )}/deliveries/${encodeURIComponent(resolved.cdngineDelivery.deliveryScopeId)}/authorize`;
  const response = await fetch(authorizationUrl, {
    body: JSON.stringify({
      responseFormat: 'url',
      variant: resolved.cdngineDelivery.variant,
    }),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cdngineToken}`,
      'content-type': 'application/json',
      'idempotency-key': `backstage-live-e2e-${Date.now()}`,
    },
    method: 'POST',
  });
  const body = await readResponseSnippet(response);
  return `${coordinates}. CDNgine authorize returned ${response.status} ${response.statusText}: ${body}`;
}

function parseRootPackageJson(bytes: Uint8Array): Record<string, unknown> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `Downloaded archive is not a readable zip file: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const rootManifest = entries['package.json'];
  if (!rootManifest) {
    const sample = Object.keys(entries).slice(0, 12).join(', ');
    throw new Error(
      `Downloaded archive did not contain root package.json. Archive entries: ${sample || '(none)'}`
    );
  }

  const parsed = JSON.parse(new TextDecoder().decode(rootManifest)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Downloaded package.json was not a JSON object.');
  }
  return parsed;
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(offset, end)).trim();
}

function parseTarEntries(tarBytes: Uint8Array): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let offset = 0;
  while (offset + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12) || '0', 8);
    offset += 512;
    if (name && Number.isFinite(size) && size >= 0) {
      entries[name] = tarBytes.subarray(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function findUnityPackageImportableAssetPaths(bytes: Uint8Array): string[] {
  const entries = parseTarEntries(gunzipSync(bytes));
  const paths: string[] = [];
  for (const [entryPath, pathnameBytes] of Object.entries(entries)) {
    if (!entryPath.endsWith('/pathname')) {
      continue;
    }
    const folder = entryPath.slice(0, -'/pathname'.length);
    if (!entries[`${folder}/asset`]) {
      continue;
    }
    const importPath = new TextDecoder().decode(pathnameBytes).trim();
    if (importPath) {
      paths.push(importPath);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function queryJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function findProductForPackage(input: {
  actor: Record<string, unknown>;
  apiSecret: string;
  client: ConvexClient;
  config: Config;
}): Promise<{ context: BuyerAccessContext; product: CatalogProduct }> {
  const products = (await input.client.query(api.providerPlatform.listCatalogProductsForTenant, {
    apiSecret: input.apiSecret,
    authUserId: input.config.creatorAuthUserId,
  })) as CatalogProduct[];

  if (products.length === 0) {
    throw new Error(`Creator ${input.config.creatorAuthUserId} has no active catalog products.`);
  }

  const contexts: BuyerAccessContext[] = [];
  for (const product of products) {
    if (input.config.catalogProductId && product._id !== input.config.catalogProductId) {
      continue;
    }
    const context = (await input.client.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        actor: input.actor,
        apiSecret: input.apiSecret,
        catalogProductId: product._id,
      }
    )) as BuyerAccessContext | null;
    if (context) {
      contexts.push(context);
    }
  }

  const match = contexts.find((context) =>
    context.backstagePackages.some((pkg) => pkg.packageId === input.config.packageId)
  );
  if (!match) {
    const productSummary = contexts
      .map((context) => {
        const refs = [context.canonicalSlug, context.providerProductRef].filter(Boolean).join('/');
        const packages = context.backstagePackages
          .map((pkg) => `${pkg.packageId}@${pkg.latestPublishedVersion ?? '(none)'}`)
          .join(', ');
        return `${context.displayName ?? context.productId} [${refs}]: ${packages || '(no packages)'}`;
      })
      .join('\n');
    throw new Error(
      `No active catalog product is linked to ${input.config.packageId}.\n${productSummary}`
    );
  }

  const product = products.find((candidate) => candidate._id === match.catalogProductId);
  if (!product) {
    throw new Error(`Matched product ${match.catalogProductId} was not returned in product list.`);
  }
  return { context: match, product };
}

async function verifyAliasInstallPlan(input: {
  apiSecret: string;
  client: ConvexClient;
  config: Config;
  context: BuyerAccessContext;
  subjectId: string;
}): Promise<{ packageCount: number; productRef: string }> {
  const now = Date.now();
  const actor = await createApiActorBinding(
    createAuthUserApiActor({
      authUserId: input.config.creatorAuthUserId,
      now,
      scopes: ['products:read'],
      source: 'oauth',
      ttlMs: 60_000,
    }),
    requireEnv('INTERNAL_SERVICE_AUTH_SECRET')
  );
  const productRef =
    input.context.canonicalSlug?.trim() || input.context.providerProductRef?.trim() || '';
  if (!productRef) {
    throw new Error(`Catalog product ${input.context.catalogProductId} has no install product ref.`);
  }

  const plan = (await input.client.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
    actor,
    apiSecret: input.apiSecret,
    authUserId: input.context.creatorAuthUserId,
    creatorRef: input.context.creatorAuthUserId,
    productRef,
    subjectId: input.subjectId,
  })) as
    | null
    | {
        packages?: Array<{
          packageId?: string;
          version?: string;
        }>;
      };
  const planPackage = plan?.packages?.find(
    (pkg) =>
      pkg.packageId === input.config.packageId &&
      (!input.config.version || pkg.version === input.config.version)
  );
  if (!planPackage) {
    throw new Error(
      `Alias install plan did not include ${input.config.packageId}@${
        input.config.version ?? '(any)'
      } for catalog product ${input.context.catalogProductId}.`
    );
  }

  return { packageCount: plan?.packages?.length ?? 0, productRef };
}

async function verifyRawPackageSourceDownload(input: {
  apiSecret: string;
  client: ConvexClient;
  config: Config;
  subjectId: string;
  tokenHash: string;
}): Promise<{
  bytes: number;
  deliveryArtifactId: string;
  importableAssetCount: number;
  importableAssetSample: string;
  sourceKind: string;
}> {
  const raw = (await input.client.query(api.backstageRepos.resolveRawPackageDownloadForApi, {
    apiSecret: input.apiSecret,
    tokenHash: input.tokenHash,
    authUserId: input.config.creatorAuthUserId,
    channel: 'stable',
    packageId: input.config.packageId,
    subjectId: input.subjectId,
    version: input.config.version,
  })) as ResolvedRawPackageDownload | null;
  if (!raw) {
    throw new Error(
      `Raw package resolver returned null for ${input.config.packageId}@${
        input.config.version ?? '(any)'
      }.`
    );
  }
  if (!raw.cdngineSource) {
    throw new Error(
      `Raw package resolver returned no CDNgine source coordinates for ${input.config.packageId}@${raw.version}.`
    );
  }
  if (raw.sourceKind !== 'unitypackage') {
    throw new Error(`Raw package source kind was ${raw.sourceKind}, expected unitypackage.`);
  }
  if (input.config.version && raw.version !== input.config.version) {
    throw new Error(`Raw package version was ${raw.version}, expected ${input.config.version}.`);
  }
  if (raw.packageSha256 !== raw.cdngineSource.sha256) {
    throw new Error(
      `Raw package SHA mismatch between resolver and CDNgine source. resolver=${raw.packageSha256} source=${raw.cdngineSource.sha256}`
    );
  }

  const cdngineBaseUrl = requireEnv('CDNGINE_API_BASE_URL').replace(/\/+$/, '');
  const cdngineToken = process.env.CDNGINE_ACCESS_TOKEN?.trim() || process.env.CDNGINE_API_TOKEN?.trim();
  if (!cdngineToken) {
    throw new Error('CDNGINE_ACCESS_TOKEN or CDNGINE_API_TOKEN is required.');
  }

  const authorizeUrl = `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(
    raw.cdngineSource.assetId
  )}/versions/${encodeURIComponent(raw.cdngineSource.versionId)}/source/authorize`;
  const authorizeResponse = await fetch(authorizeUrl, {
    body: JSON.stringify({
      oneTime: true,
      preferredDisposition: 'attachment',
    }),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cdngineToken}`,
      'content-type': 'application/json',
      'idempotency-key': `backstage-live-e2e-raw-source-${raw.deliveryArtifactId}-${Date.now()}`,
    },
    method: 'POST',
  });
  if (!authorizeResponse.ok) {
    throw new Error(
      `CDNgine source authorize failed: ${authorizeResponse.status} ${
        authorizeResponse.statusText
      }: ${await readResponseSnippet(authorizeResponse)}`
    );
  }
  const authorization = (await authorizeResponse.json()) as unknown;
  if (!isRecord(authorization) || typeof authorization.url !== 'string') {
    throw new Error('CDNgine source authorize response did not include a download URL.');
  }

  const downloadUrl = authorization.url.startsWith('/')
    ? `${cdngineBaseUrl}${authorization.url}`
    : authorization.url;
  const downloadResponse = await fetch(downloadUrl, {
    headers: {
      accept: raw.contentType,
      'accept-encoding': 'identity',
    },
  });
  if (!downloadResponse.ok) {
    throw new Error(
      `CDNgine raw source download failed: ${downloadResponse.status} ${
        downloadResponse.statusText
      }: ${await readResponseSnippet(downloadResponse)}`
    );
  }

  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const actualSha = sha256Hex(bytes);
  if (actualSha !== raw.packageSha256) {
    throw new Error(
      `Raw unitypackage SHA mismatch. expected=${raw.packageSha256} actual=${actualSha}`
    );
  }
  if (bytes.byteLength !== raw.cdngineSource.byteSize) {
    throw new Error(
      `Raw unitypackage byte size mismatch. expected=${raw.cdngineSource.byteSize} actual=${bytes.byteLength}`
    );
  }
  const importableAssetPaths = findUnityPackageImportableAssetPaths(bytes);
  if (importableAssetPaths.length === 0) {
    throw new Error('Raw unitypackage did not contain any importable pathname/asset entries.');
  }

  return {
    bytes: bytes.byteLength,
    deliveryArtifactId: raw.deliveryArtifactId,
    importableAssetCount: importableAssetPaths.length,
    importableAssetSample: importableAssetPaths.slice(0, 5).join(', '),
    sourceKind: raw.sourceKind,
  };
}

async function verifyInstallablePackageDownload(input: {
  apiSecret: string;
  client: ConvexClient;
  config: Config;
  subjectId: string;
  tokenHash: string;
}): Promise<{ bytes: number; deliveryArtifactId?: string; sourceKind: 'zip' }> {
  const resolved = (await input.client.query(api.backstageRepos.resolvePackageDownloadForApi, {
    apiSecret: input.apiSecret,
    tokenHash: input.tokenHash,
    authUserId: input.config.creatorAuthUserId,
    channel: 'stable',
    packageId: input.config.packageId,
    subjectId: input.subjectId,
    version: input.config.version,
  })) as ResolvedPackageDownload | null;
  if (!resolved) {
    throw new Error(
      `Installable package resolver returned null for ${input.config.packageId}@${
        input.config.version ?? '(any)'
      }.`
    );
  }
  if (input.config.version && resolved.version !== input.config.version) {
    throw new Error(
      `Installable package version was ${resolved.version}, expected ${input.config.version}.`
    );
  }
  const expectedSha = resolved.zipSha256?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new Error(
      `Installable package resolver returned invalid ZIP digest for ${input.config.packageId}@${resolved.version}.`
    );
  }
  if (!resolved.cdngineDelivery) {
    throw new Error(
      `Installable package resolver returned no CDNgine delivery coordinates for ${input.config.packageId}@${resolved.version}.`
    );
  }

  const cdngineBaseUrl = requireEnv('CDNGINE_API_BASE_URL').replace(/\/+$/, '');
  const cdngineToken = process.env.CDNGINE_ACCESS_TOKEN?.trim() || process.env.CDNGINE_API_TOKEN?.trim();
  if (!cdngineToken) {
    throw new Error('CDNGINE_ACCESS_TOKEN or CDNGINE_API_TOKEN is required.');
  }

  const authorizeUrl = `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(
    resolved.cdngineDelivery.assetId
  )}/versions/${encodeURIComponent(
    resolved.cdngineDelivery.versionId
  )}/deliveries/${encodeURIComponent(resolved.cdngineDelivery.deliveryScopeId)}/authorize`;
  const authorizeResponse = await fetch(authorizeUrl, {
    body: JSON.stringify({
      responseFormat: 'url',
      variant: resolved.cdngineDelivery.variant,
    }),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cdngineToken}`,
      'content-type': 'application/json',
      'idempotency-key': `backstage-live-e2e-installable-${resolved.deliveryArtifactId ?? resolved.version}-${Date.now()}`,
    },
    method: 'POST',
  });
  if (!authorizeResponse.ok) {
    throw new Error(
      `CDNgine installable package authorize failed: ${authorizeResponse.status} ${
        authorizeResponse.statusText
      }: ${await readResponseSnippet(authorizeResponse)}`
    );
  }
  const authorization = (await authorizeResponse.json()) as unknown;
  if (!isRecord(authorization) || typeof authorization.url !== 'string') {
    throw new Error('CDNgine installable package authorize response did not include a download URL.');
  }

  const downloadUrl = authorization.url.startsWith('/')
    ? `${cdngineBaseUrl}${authorization.url}`
    : authorization.url;
  const downloadResponse = await fetch(downloadUrl, {
    headers: {
      accept: 'application/zip',
      'accept-encoding': 'identity',
    },
  });
  if (!downloadResponse.ok) {
    throw new Error(
      `CDNgine installable package download failed: ${downloadResponse.status} ${
        downloadResponse.statusText
      }: ${await readResponseSnippet(downloadResponse)}`
    );
  }

  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const actualSha = sha256Hex(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`Installable ZIP SHA mismatch. expected=${expectedSha} actual=${actualSha}`);
  }
  const packageJson = parseRootPackageJson(bytes);
  if (packageJson.name !== input.config.packageId) {
    throw new Error(
      `Installable package.json name was ${String(packageJson.name)}, expected ${input.config.packageId}.`
    );
  }
  if (input.config.version && packageJson.version !== input.config.version) {
    throw new Error(
      `Installable package.json version was ${String(packageJson.version)}, expected ${input.config.version}.`
    );
  }

  return {
    bytes: bytes.byteLength,
    deliveryArtifactId: resolved.deliveryArtifactId,
    sourceKind: 'zip',
  };
}

async function resolveSubjectWithEntitlement(input: {
  actor: Record<string, unknown>;
  apiSecret: string;
  client: ConvexClient;
  config: Config;
  product: CatalogProduct;
}): Promise<string> {
  const authSubject = (await input.client.query(api.backstageRepos.getSubjectByAuthUserForApi, {
    apiSecret: input.apiSecret,
    actor: input.actor,
    authUserId: input.config.creatorAuthUserId,
  })) as { _id: string } | null;
  if (authSubject) {
    return authSubject._id;
  }

  const entitlements = (await input.client.query(api.entitlements.getEntitlementsByProduct, {
    actor: input.actor,
    apiSecret: input.apiSecret,
    authUserId: input.config.creatorAuthUserId,
    includeInactive: false,
    productId: input.product.productId,
  })) as Entitlement[];

  const existing = entitlements.find(
    (entitlement) =>
      entitlement.status === 'active' && entitlement.catalogProductId === input.product._id
  );
  if (existing) {
    return existing.subjectId;
  }

  if (!input.config.ensureSmokeEntitlement) {
    throw new Error(
      `No active entitlement exists for ${input.product.displayName ?? input.product.productId}.`
    );
  }

  const subject = (await input.client.mutation(api.subjects.ensureSubjectForDiscord, {
    actor: input.actor,
    apiSecret: input.apiSecret,
    discordUserId: `backstage-live-e2e-${input.config.creatorAuthUserId}-${input.config.packageId}`,
    displayName: `Backstage live E2E ${input.config.packageId}`,
  })) as { subjectId: string };

  await input.client.mutation(api.entitlements.grantEntitlement, {
    actor: input.actor,
    apiSecret: input.apiSecret,
    authUserId: input.config.creatorAuthUserId,
    catalogProductId: input.product._id,
    correlationId: `backstage-live-e2e:${input.config.packageId}`,
    evidence: {
      provider: input.product.provider,
      sourceReference: `backstage-live-e2e:${input.product._id}:${input.config.packageId}`,
      purchasedAt: Date.now(),
      rawEvidence: {
        kind: 'backstage-live-download-e2e',
      },
    },
    productId: input.product.productId,
    subjectId: subject.subjectId,
  });

  return subject.subjectId;
}

async function issueRepoToken(input: {
  actor: Record<string, unknown>;
  apiSecret: string;
  client: ConvexClient;
  config: Config;
  subjectId: string;
}): Promise<string> {
  const issued = (await input.client.mutation(api.backstageRepos.issueRepoTokenForApi, {
    apiSecret: input.apiSecret,
    actor: input.actor,
    authUserId: input.config.creatorAuthUserId,
    expiresAt: Date.now() + 5 * 60 * 1000,
    label: `Backstage live E2E ${input.config.packageId}`,
    subjectId: input.subjectId,
  })) as { token: string };
  return issued.token;
}

async function runOnce(config: Config): Promise<void> {
  const apiSecret = requireEnv('CONVEX_API_SECRET');
  const convexUrl = requireEnv('CONVEX_URL');
  const client = new ConvexHttpClient(convexUrl) as unknown as ConvexClient;
  const actor = (await createServiceActorBinding({
    service: 'backstage-live-download-e2e',
    scopes: ['creator:delegate', 'subjects:service'],
  })) as unknown as Record<string, unknown>;

  const profile = (await client.query(api.creatorProfiles.getCreatorProfile, {
    apiSecret,
    authUserId: config.creatorAuthUserId,
  })) as { slug?: string; name?: string } | null;
  const creatorRepoRef = profile?.slug?.trim() || config.creatorAuthUserId;

  const { context, product } = await findProductForPackage({ actor, apiSecret, client, config });
  const productPackage = context.backstagePackages.find((pkg) => pkg.packageId === config.packageId);
  if (config.version && productPackage?.latestPublishedVersion !== config.version) {
    throw new Error(
      `${config.packageId} latest published version is ${
        productPackage?.latestPublishedVersion ?? '(none)'
      }, expected ${config.version}.`
    );
  }

  const subjectId = await resolveSubjectWithEntitlement({
    actor,
    apiSecret,
    client,
    config,
    product,
  });
  const installPlan = await verifyAliasInstallPlan({
    apiSecret,
    client,
    config,
    context,
    subjectId,
  });
  const token = await issueRepoToken({ actor, apiSecret, client, config, subjectId });
  const tokenHash = sha256Hex(new TextEncoder().encode(token));
  const rawSource = await verifyRawPackageSourceDownload({
    apiSecret,
    client,
    config,
    subjectId,
    tokenHash,
  });
  const installablePackage = await verifyInstallablePackageDownload({
    apiSecret,
    client,
    config,
    subjectId,
    tokenHash,
  });
  const repoHeaders = { 'X-YUCP-Repo-Token': token };
  const repositoryUrl = `${config.apiBaseUrl}/v1/backstage/repos/${encodeURIComponent(
    creatorRepoRef
  )}/index.json`;
  const repository = await queryJson(repositoryUrl, repoHeaders);
  const repoPackages = flattenRepoPackages(repository, repoHeaders);
  const repoPackage = repoPackages.find(
    (pkg) =>
      pkg.packageId === config.packageId && (!config.version || pkg.version === config.version)
  );
  if (!repoPackage) {
    const exposed = repoPackages.map((pkg) => `${pkg.packageId}@${pkg.version}`).join(', ');
    throw new Error(
      `Repository did not expose ${config.packageId}@${config.version ?? '(any)'}. Exposed: ${
        exposed || '(none)'
      }`
    );
  }

  const response = await fetch(repoPackage.url, { headers: repoPackage.headers });
  if (!response.ok) {
    const body = await readResponseSnippet(response);
    const delivery = await describeDeliveryAuthorization({
      apiSecret,
      client,
      config,
      repoPackage,
      subjectId,
      tokenHash,
    });
    throw new Error(
      `Package download failed for ${repoPackage.packageId}@${repoPackage.version}: ${response.status} ${response.statusText}. Body: ${body}. ${delivery}`
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const expectedSha = repoPackage.manifest.zipSHA256;
  const actualSha = sha256Hex(bytes);
  if (typeof expectedSha === 'string' && expectedSha !== actualSha) {
    throw new Error(`Downloaded archive SHA mismatch. expected=${expectedSha} actual=${actualSha}`);
  }

  const packageJson = parseRootPackageJson(bytes);
  if (packageJson.name !== config.packageId) {
    throw new Error(
      `Downloaded package.json name was ${String(packageJson.name)}, expected ${config.packageId}.`
    );
  }
  if (config.version && packageJson.version !== config.version) {
    throw new Error(
      `Downloaded package.json version was ${String(packageJson.version)}, expected ${config.version}.`
    );
  }

  console.log(
    [
      `downloaded ${repoPackage.packageId}@${repoPackage.version}`,
      `product=${context.displayName ?? context.productId}`,
      `installPlanProductRef=${installPlan.productRef}`,
      `installPlanPackages=${installPlan.packageCount}`,
      `shimPackageArtifact=${installablePackage.deliveryArtifactId ?? '(unknown)'}`,
      `shimPackageSourceKind=${installablePackage.sourceKind}`,
      `shimPackageBytes=${installablePackage.bytes}`,
      `rawSourceArtifact=${rawSource.deliveryArtifactId}`,
      `rawSourceKind=${rawSource.sourceKind}`,
      `rawSourceBytes=${rawSource.bytes}`,
      `rawSourceImportableAssets=${rawSource.importableAssetCount}`,
      `rawSourceImportableSample=${rawSource.importableAssetSample}`,
      `repo=${repositoryUrl}`,
      `finalUrl=${response.url}`,
      `bytes=${bytes.byteLength}`,
      `sha256=${actualSha}`,
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const config = readConfig();
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      await runOnce(config);
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `[backstage-live-download-e2e] attempt ${attempt}/${config.attempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (attempt < config.attempts && config.intervalMs > 0) {
        await sleep(config.intervalMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[backstage-live-download-e2e]', error);
    process.exit(1);
  });
}
