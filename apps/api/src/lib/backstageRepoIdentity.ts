import { api } from '../../../../convex/_generated/api';

type ConvexQueryClient = {
  query: <TResult = unknown>(
    reference: unknown,
    args?: Record<string, unknown>
  ) => Promise<TResult>;
};

type CreatorProfileRecord = {
  name: string;
  slug?: string;
} | null;

type AuthViewerRecord = {
  name?: string | null;
} | null;

export type CreatorRepoIdentity = {
  creatorName?: string;
  creatorRepoRef: string;
  creatorSlug?: string;
  repositoryId: string;
  repositoryName: string;
};

function sanitizeRepositoryIdSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'creator';
}

function trimOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function humanizeCreatorSlug(value: string | undefined): string | undefined {
  const normalized = trimOptional(value)?.replace(/[-_]+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  return normalized
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

function isSyntheticCreatorName(value: string | undefined): boolean {
  const normalized = trimOptional(value);
  if (!normalized) {
    return false;
  }

  return /^creator\s+\d+$/iu.test(normalized);
}

function isFriendlyCreatorName(value: string | undefined): value is string {
  const normalized = trimOptional(value);
  return (
    typeof normalized === 'string' &&
    /[\p{L}]/u.test(normalized) &&
    !isSyntheticCreatorName(normalized)
  );
}

export function buildCreatorRepoRef(input: { authUserId: string; creatorSlug?: string }): string {
  return input.creatorSlug?.trim() || input.authUserId.trim();
}

export function buildBackstageRepositoryUrls(apiBaseUrl: string, creatorRepoRef: string) {
  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  const encodedCreatorRepoRef = encodeURIComponent(creatorRepoRef);
  return {
    packageBaseUrl: `${baseUrl}/v1/backstage/repos/${encodedCreatorRepoRef}/package`,
    repositoryUrl: `${baseUrl}/v1/backstage/repos/${encodedCreatorRepoRef}/index.json`,
  };
}

export async function getCreatorRepoIdentity(input: {
  convex: ConvexQueryClient;
  convexApiSecret: string;
  authUserId: string;
}): Promise<CreatorRepoIdentity> {
  const [profile, viewer] = await Promise.all([
    input.convex.query<CreatorProfileRecord>(api.creatorProfiles.getCreatorByAuthUser, {
      apiSecret: input.convexApiSecret,
      authUserId: input.authUserId,
    }),
    input.convex.query<AuthViewerRecord>(api.authViewer.getViewerByAuthUser, {
      apiSecret: input.convexApiSecret,
      authUserId: input.authUserId,
    }),
  ]);
  const creatorRepoRef = buildCreatorRepoRef({
    authUserId: input.authUserId,
    creatorSlug: profile?.slug,
  });
  const configuredCreatorName = isFriendlyCreatorName(profile?.name)
    ? profile?.name.trim()
    : undefined;
  const discordCreatorName = isFriendlyCreatorName(viewer?.name ?? undefined)
    ? viewer?.name?.trim()
    : undefined;
  const creatorName =
    configuredCreatorName ?? discordCreatorName ?? humanizeCreatorSlug(profile?.slug);

  return {
    creatorName,
    creatorRepoRef,
    creatorSlug: profile?.slug,
    repositoryId: `club.yucp.backstage.${sanitizeRepositoryIdSegment(creatorRepoRef)}`,
    repositoryName: creatorName ? `${creatorName} repo` : 'Backstage repo',
  };
}
