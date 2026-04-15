import { buildPublicAuthIssuer } from '@yucp/shared/publicAuthority';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import {
  buildRuntimeArtifactDownloadUrl,
  fetchRuntimeArtifactManifest,
  type RuntimeArtifactKey,
} from '../lib/couplingRuntimeArtifacts';
import {
  type CouplingRuntimeClaims,
  type CouplingRuntimePackageClaims,
  resolvePinnedYucpSigningRoot,
  signCouplingRuntimeJwt,
  signCouplingRuntimePackageJwt,
  verifyLicenseJwtAgainstPinnedRoots,
} from '../lib/yucpRuntimeCrypto';

const PROJECT_ID_RE = /^[a-f0-9]{32}$/;
const COUPLING_RUNTIME_TTL_SECONDS = 10 * 60;
const COUPLING_RUNTIME_PACKAGE_TTL_SECONDS = 10 * 60;

export type CouplingLicenseConfig = {
  apiBaseUrl: string;
  couplingServiceBaseUrl: string;
  couplingServiceSharedSecret: string;
  convexApiSecret: string;
  convexUrl: string;
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function getIssuerBaseUrl(config: CouplingLicenseConfig): string {
  return config.apiBaseUrl.trim().replace(/\/$/, '');
}

function getApiRuntimeDownloadPath(artifactKey: RuntimeArtifactKey): string {
  return artifactKey === 'coupling-runtime'
    ? '/v1/licenses/coupling-runtime'
    : '/v1/licenses/runtime-package';
}

async function getPinnedSigningRoot(): Promise<{
  keyId: string;
  privateKeyBase64: string;
}> {
  const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY?.trim();
  if (!rootPrivateKey) {
    throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');
  }

  const signingRoot = await resolvePinnedYucpSigningRoot(
    rootPrivateKey,
    process.env.YUCP_ROOT_KEY_ID?.trim() || null
  );

  return {
    keyId: signingRoot.keyId,
    privateKeyBase64: rootPrivateKey,
  };
}

async function signRuntimeArtifactToken(
  claims: Omit<CouplingRuntimeClaims, 'aud'> | Omit<CouplingRuntimePackageClaims, 'aud'>,
  audience: CouplingRuntimeClaims['aud'] | CouplingRuntimePackageClaims['aud']
): Promise<string> {
  const signingRoot = await getPinnedSigningRoot();
  if (audience === 'yucp-runtime-package') {
    return await signCouplingRuntimePackageJwt(
      {
        ...claims,
        aud: 'yucp-runtime-package',
      } as CouplingRuntimePackageClaims,
      signingRoot.privateKeyBase64,
      signingRoot.keyId
    );
  }

  return await signCouplingRuntimeJwt(
    {
      ...claims,
      aud: 'yucp-coupling-runtime',
    } as CouplingRuntimeClaims,
    signingRoot.privateKeyBase64,
    signingRoot.keyId
  );
}

async function resolveRuntimeArtifact(
  config: CouplingLicenseConfig,
  artifactKey: RuntimeArtifactKey
) {
  const artifact = await fetchRuntimeArtifactManifest(
    config.couplingServiceBaseUrl,
    config.couplingServiceSharedSecret,
    artifactKey
  );
  if (!artifact.success) {
    return artifact;
  }

  return artifact;
}

async function getRuntimeArtifactManifest(
  request: Request,
  config: CouplingLicenseConfig
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const artifactKey = requestUrl.searchParams.get('artifactKey');
  if (artifactKey !== 'coupling-runtime' && artifactKey !== 'coupling-runtime-package') {
    return errorResponse(
      'artifactKey query parameter must be coupling-runtime or coupling-runtime-package',
      400
    );
  }

  const artifact = await resolveRuntimeArtifact(config, artifactKey);
  if (!artifact.success) {
    return errorResponse(artifact.error, 503);
  }

  return jsonResponse({
    ...artifact,
    downloadUrl: `${getIssuerBaseUrl(config)}${getApiRuntimeDownloadPath(artifactKey)}`,
  });
}

async function issueRuntimePackageToken(
  request: Request,
  config: CouplingLicenseConfig
): Promise<Response> {
  let body: {
    packageId: string;
    projectId: string;
    machineFingerprint: string;
    licenseToken: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { packageId, projectId, machineFingerprint, licenseToken } = body ?? {};
  if (!packageId || !projectId || !machineFingerprint || !licenseToken) {
    return errorResponse(
      'packageId, projectId, machineFingerprint, and licenseToken are required',
      400
    );
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return errorResponse('Invalid projectId format', 400);
  }

  const issuerBaseUrl = getIssuerBaseUrl(config);
  try {
    await getPinnedSigningRoot();
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Pinned root trust is unavailable',
      503
    );
  }

  const licenseClaims = await verifyLicenseJwtAgainstPinnedRoots(
    licenseToken,
    buildPublicAuthIssuer(issuerBaseUrl)
  );
  if (!licenseClaims) {
    return errorResponse('License token is invalid or expired', 401);
  }
  if (
    licenseClaims.package_id !== packageId ||
    licenseClaims.machine_fingerprint !== machineFingerprint
  ) {
    return errorResponse('License token did not match this package or machine', 401);
  }

  const artifact = await resolveRuntimeArtifact(config, 'coupling-runtime-package');
  if (!artifact.success) {
    return errorResponse(
      artifact.error ?? 'Coupling runtime package is not configured on the server',
      503
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = nowSeconds + COUPLING_RUNTIME_PACKAGE_TTL_SECONDS;
  const runtimePackageToken = await signRuntimeArtifactToken(
    {
      iss: buildPublicAuthIssuer(issuerBaseUrl),
      sub: licenseClaims.sub,
      jti: crypto.randomUUID(),
      package_id: packageId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      artifact_key: artifact.artifactKey,
      artifact_channel: artifact.channel,
      artifact_platform: artifact.platform,
      artifact_version: artifact.version,
      metadata_version: artifact.metadataVersion,
      delivery_name: artifact.deliveryName,
      content_type: artifact.contentType,
      envelope_cipher: artifact.envelopeCipher,
      envelope_iv_b64: artifact.envelopeIvBase64,
      ciphertext_sha256: artifact.ciphertextSha256,
      ciphertext_size: artifact.ciphertextSize,
      plaintext_sha256: artifact.plaintextSha256,
      plaintext_size: artifact.plaintextSize,
      code_signing_subject: artifact.codeSigningSubject,
      code_signing_thumbprint: artifact.codeSigningThumbprint,
      iat: nowSeconds,
      exp,
    },
    'yucp-runtime-package'
  );

  return jsonResponse({
    success: true,
    runtimePackageToken,
    runtimePackageSha256: artifact.plaintextSha256,
    runtimePackageUrl: buildRuntimeArtifactDownloadUrl(artifact, runtimePackageToken),
    expiresAt: exp,
  });
}

async function issueCouplingJob(
  request: Request,
  config: CouplingLicenseConfig
): Promise<Response> {
  let body: {
    packageId: string;
    projectId: string;
    machineFingerprint: string;
    licenseToken: string;
    assetPaths: string[];
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { packageId, projectId, machineFingerprint, licenseToken, assetPaths } = body ?? {};
  if (
    !packageId ||
    !projectId ||
    !machineFingerprint ||
    !licenseToken ||
    !Array.isArray(assetPaths)
  ) {
    return errorResponse(
      'packageId, projectId, machineFingerprint, licenseToken, and assetPaths are required',
      400
    );
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return errorResponse('Invalid projectId format', 400);
  }

  const artifact = await resolveRuntimeArtifact(config, 'coupling-runtime');
  if (!artifact.success) {
    return errorResponse(artifact.error ?? 'Coupling runtime is not configured on the server', 503);
  }

  try {
    await getPinnedSigningRoot();
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Pinned root trust is unavailable',
      503
    );
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const issued = (await convex.action(api.yucpLicenses.issueCouplingJobForApi, {
    apiSecret: config.convexApiSecret,
    packageId,
    projectId,
    machineFingerprint,
    licenseToken,
    assetPaths,
    issuerBaseUrl: getIssuerBaseUrl(config),
    runtimeArtifactVersion: artifact.version,
    runtimePlaintextSha256: artifact.plaintextSha256,
  })) as {
    success: boolean;
    subject?: string;
    jobs?: Array<{ assetPath: string; tokenHex: string; materializationNonce: string }>;
    skipReason?: string;
    error?: string;
  };

  if (!issued.success) {
    return jsonResponse({ error: issued.error }, 422);
  }
  if (!issued.jobs || issued.jobs.length === 0) {
    return jsonResponse({
      success: true,
      files: [],
      skipReason: issued.skipReason,
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = nowSeconds + COUPLING_RUNTIME_TTL_SECONDS;
  const runtimeToken = await signRuntimeArtifactToken(
    {
      iss: buildPublicAuthIssuer(getIssuerBaseUrl(config)),
      sub: issued.subject ?? '',
      jti: crypto.randomUUID(),
      package_id: packageId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      artifact_key: artifact.artifactKey,
      artifact_channel: artifact.channel,
      artifact_platform: artifact.platform,
      artifact_version: artifact.version,
      metadata_version: artifact.metadataVersion,
      delivery_name: artifact.deliveryName,
      content_type: artifact.contentType,
      envelope_cipher: artifact.envelopeCipher,
      envelope_iv_b64: artifact.envelopeIvBase64,
      ciphertext_sha256: artifact.ciphertextSha256,
      ciphertext_size: artifact.ciphertextSize,
      plaintext_sha256: artifact.plaintextSha256,
      plaintext_size: artifact.plaintextSize,
      code_signing_subject: artifact.codeSigningSubject,
      code_signing_thumbprint: artifact.codeSigningThumbprint,
      iat: nowSeconds,
      exp,
    },
    'yucp-coupling-runtime'
  );

  return jsonResponse({
    success: true,
    runtimeToken,
    runtimeSha256: artifact.plaintextSha256,
    runtimeUrl: buildRuntimeArtifactDownloadUrl(artifact, runtimeToken),
    expiresAt: exp,
    files: issued.jobs,
    skipReason: issued.skipReason,
  });
}

async function issueProtectedMaterializationGrant(
  request: Request,
  config: CouplingLicenseConfig
): Promise<Response> {
  let body: {
    packageId: string;
    protectedAssetId: string;
    projectId: string;
    machineFingerprint: string;
    licenseToken: string;
    assetPaths: string[];
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { packageId, protectedAssetId, projectId, machineFingerprint, licenseToken, assetPaths } =
    body ?? {};
  if (
    !packageId ||
    !protectedAssetId ||
    !projectId ||
    !machineFingerprint ||
    !licenseToken ||
    !Array.isArray(assetPaths)
  ) {
    return errorResponse(
      'packageId, protectedAssetId, projectId, machineFingerprint, licenseToken, and assetPaths are required',
      400
    );
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return errorResponse('Invalid projectId format', 400);
  }

  const artifact = await resolveRuntimeArtifact(config, 'coupling-runtime');
  if (!artifact.success) {
    return errorResponse(artifact.error ?? 'Coupling runtime is not configured on the server', 503);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const result = (await convex.action(api.yucpLicenses.issueProtectedMaterializationGrantForApi, {
    apiSecret: config.convexApiSecret,
    packageId,
    protectedAssetId,
    machineFingerprint,
    projectId,
    licenseToken,
    assetPaths,
    issuerBaseUrl: getIssuerBaseUrl(config),
    runtimeArtifactVersion: artifact.version,
    runtimePlaintextSha256: artifact.plaintextSha256,
  })) as {
    success: boolean;
    grant?: string;
    expiresAt?: number;
    error?: string;
  };

  if (!result.success) {
    return jsonResponse({ error: result.error }, 422);
  }

  return jsonResponse({
    success: true,
    grant: result.grant,
    expiresAt: result.expiresAt,
  });
}

async function issueProtectedInstallIntent(
  request: Request,
  config: CouplingLicenseConfig
): Promise<Response> {
  let body: {
    packageId: string;
    protectedAssetId: string;
    projectId: string;
    machineFingerprint: string;
    manifestBindingSha256: string;
    licenseToken: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const {
    packageId,
    protectedAssetId,
    projectId,
    machineFingerprint,
    manifestBindingSha256,
    licenseToken,
  } = body ?? {};
  if (
    !packageId ||
    !protectedAssetId ||
    !projectId ||
    !machineFingerprint ||
    !manifestBindingSha256 ||
    !licenseToken
  ) {
    return errorResponse(
      'packageId, protectedAssetId, projectId, machineFingerprint, manifestBindingSha256, and licenseToken are required',
      400
    );
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return errorResponse('Invalid projectId format', 400);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const result = (await convex.action(api.yucpLicenses.issueProtectedInstallIntentForApi, {
    apiSecret: config.convexApiSecret,
    packageId,
    protectedAssetId,
    machineFingerprint,
    projectId,
    manifestBindingSha256,
    licenseToken,
    issuerBaseUrl: getIssuerBaseUrl(config),
  })) as {
    success: boolean;
    installIntentToken?: string;
    expiresAt?: number;
    error?: string;
  };

  if (!result.success) {
    return jsonResponse({ error: result.error }, 422);
  }

  return jsonResponse({
    success: true,
    installIntentToken: result.installIntentToken,
    expiresAt: result.expiresAt,
  });
}

async function redirectToRuntimeArtifact(
  request: Request,
  config: CouplingLicenseConfig,
  artifactKey: RuntimeArtifactKey
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const token = requestUrl.searchParams.get('token');
  if (!token) {
    return errorResponse('token query parameter is required', 400);
  }

  const artifact = await resolveRuntimeArtifact(config, artifactKey);
  if (!artifact.success) {
    return errorResponse(artifact.error, 503);
  }

  return Response.redirect(buildRuntimeArtifactDownloadUrl(artifact, token), 307);
}

export function createCouplingLicenseRoutes(config: CouplingLicenseConfig) {
  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/licenses/runtime-package-token') {
        return await issueRuntimePackageToken(request, config);
      }
      if (request.method === 'POST' && url.pathname === '/v1/licenses/coupling-job') {
        return await issueCouplingJob(request, config);
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/v1/licenses/protected-materialization-grant'
      ) {
        return await issueProtectedMaterializationGrant(request, config);
      }
      if (request.method === 'POST' && url.pathname === '/v1/licenses/protected-install-intent') {
        return await issueProtectedInstallIntent(request, config);
      }
      if (request.method === 'GET' && url.pathname === '/v1/runtime-artifacts/manifest') {
        return await getRuntimeArtifactManifest(request, config);
      }
      if (request.method === 'GET' && url.pathname === '/v1/licenses/runtime-package') {
        return await redirectToRuntimeArtifact(request, config, 'coupling-runtime-package');
      }
      if (request.method === 'GET' && url.pathname === '/v1/licenses/coupling-runtime') {
        return await redirectToRuntimeArtifact(request, config, 'coupling-runtime');
      }

      return null;
    },
  };
}
