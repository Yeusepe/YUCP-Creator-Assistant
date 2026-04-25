import type { StructuredLogger } from '@yucp/shared';
import {
  CredentialExpiredError,
  type ProductRecord,
  type ProviderContext,
  type ProviderPurposes,
  type ProviderRuntimeClient,
  type ProviderRuntimeModule,
  type ProviderTierRecord,
} from '../contracts';

const PATREON_API_BASE = 'https://www.patreon.com/api/oauth2/v2';

export const PATREON_PURPOSES = {
  credential: 'patreon-oauth-access-token',
  refreshToken: 'patreon-oauth-refresh-token',
  buyerCredential: 'patreon-buyer-oauth-access-token',
  buyerRefreshToken: 'patreon-buyer-oauth-refresh-token',
} as const satisfies ProviderPurposes;

export const PATREON_DISPLAY_META = {
  dashboardSetupExperience: 'automatic',
  dashboardSetupHint:
    'Connect Patreon with OAuth, then map campaign tiers to Discord roles in the product flow.',
  label: 'Patreon',
  icon: 'Patreon.png',
  color: '#ff424d',
  shadowColor: '#ff424d',
  textColor: '#ffffff',
  connectedColor: '#ff6b74',
  confettiColors: ['#ff424d', '#ff6b74', '#ffd1d4', '#ffffff'],
  description: 'Memberships',
  dashboardConnectPath: '/api/connect/patreon/begin',
  dashboardConnectParamStyle: 'camelCase',
  dashboardIconBg: '#2b1113',
  dashboardQuickStartBg: 'rgba(255,66,77,0.12)',
  dashboardQuickStartBorder: 'rgba(255,66,77,0.32)',
  dashboardServerTileHint:
    'Connect Patreon so campaign tiers can be mapped to Discord roles in this server.',
} as const;

type PatreonRuntimeLogger = Pick<StructuredLogger, 'warn'>;
type PatreonFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface PatreonCampaignAttributes {
  creation_name?: string | null;
  patron_count?: number | null;
  summary?: string | null;
  url?: string | null;
}

interface PatreonTierAttributes {
  amount_cents?: number | null;
  description?: string | null;
  discord_role_ids?: string[] | null;
  patron_count?: number | null;
  published?: boolean | null;
  title?: string | null;
  url?: string | null;
}

interface PatreonUserAttributes {
  email?: string | null;
  full_name?: string | null;
  image_url?: string | null;
  thumb_url?: string | null;
  url?: string | null;
  vanity?: string | null;
}

interface PatreonMemberAttributes {
  currently_entitled_amount_cents?: number | null;
  last_charge_date?: string | null;
  last_charge_status?: string | null;
  patron_status?: string | null;
  pledge_relationship_start?: string | null;
}

interface PatreonRelationshipRecord {
  data?:
    | {
        id: string;
        type: string;
      }
    | Array<{
        id: string;
        type: string;
      }>
    | null;
}

interface PatreonJsonApiResource<TAttributes> {
  id: string;
  type: string;
  attributes?: TAttributes;
  relationships?: Record<string, PatreonRelationshipRecord | undefined>;
}

interface PatreonJsonApiResponse<TAttributes, TIncludedAttributes = PatreonTierAttributes> {
  data: PatreonJsonApiResource<TAttributes> | PatreonJsonApiResource<TAttributes>[];
  included?: PatreonJsonApiResource<TIncludedAttributes>[];
}

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export interface PatreonBuyerMembershipRecord {
  campaignId?: string;
  entitledTierIds: string[];
  id: string;
  lastChargeDate?: string;
  lastChargeStatus?: string;
  patronStatus?: string;
  pledgeRelationshipStart?: string;
}

export interface PatreonBuyerIdentityRecord {
  avatarUrl?: string;
  email?: string;
  memberships: PatreonBuyerMembershipRecord[];
  profileUrl?: string;
  providerUserId: string;
  username?: string;
}

export interface PatreonRuntimePorts<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  readonly logger: PatreonRuntimeLogger;
  getEncryptedCredential(ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
  fetchImpl?: PatreonFetchLike;
}

export type PatreonProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill' | 'buyerVerification'> & {
    readonly buyerVerification?: undefined;
  };

function getFetch(ports: PatreonRuntimePorts): PatreonFetchLike {
  return ports.fetchImpl ?? fetch;
}

async function fetchPatreonJson<TAttributes, TIncludedAttributes = PatreonTierAttributes>(
  accessToken: string,
  url: URL,
  ports: PatreonRuntimePorts
): Promise<PatreonJsonApiResponse<TAttributes, TIncludedAttributes>> {
  const response = await getFetch(ports)(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401) {
    throw new CredentialExpiredError('patreon');
  }
  if (!response.ok) {
    throw new Error(`Patreon API error: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as PatreonJsonApiResponse<TAttributes, TIncludedAttributes>;
}

function getRelationshipIds(
  resource: PatreonJsonApiResource<unknown>,
  relationshipName: string
): string[] {
  const relationship = resource.relationships?.[relationshipName];
  if (!relationship?.data) {
    return [];
  }
  const values = Array.isArray(relationship.data) ? relationship.data : [relationship.data];
  return values
    .map((entry) => entry?.id?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function getSingleRelationshipId(
  resource: PatreonJsonApiResource<unknown>,
  relationshipName: string
): string | undefined {
  return getRelationshipIds(resource, relationshipName)[0];
}

export async function fetchPatreonBuyerIdentity(
  accessToken: string,
  ports: Pick<PatreonRuntimePorts, 'fetchImpl'> = {}
): Promise<PatreonBuyerIdentityRecord> {
  // Patreon identity and scope docs:
  // https://docs.patreon.com/#get-api-oauth2-v2-identity
  // https://docs.patreon.com/#scopes
  const url = new URL(`${PATREON_API_BASE}/identity`);
  url.searchParams.set('include', 'memberships,campaign');
  url.searchParams.set('fields[user]', 'email,full_name,image_url,thumb_url,url,vanity');
  url.searchParams.set(
    'fields[member]',
    'currently_entitled_amount_cents,last_charge_date,last_charge_status,patron_status,pledge_relationship_start'
  );

  const response = await fetchPatreonJson<PatreonUserAttributes, PatreonMemberAttributes>(
    accessToken,
    url,
    {
      logger: { warn() {} },
      fetchImpl: ports.fetchImpl,
      async getEncryptedCredential() {
        return null;
      },
      async decryptCredential() {
        throw new Error('decryptCredential is not available in buyer identity reads');
      },
    }
  );

  const user = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!user?.id) {
    throw new Error('Patreon identity response did not include a user id');
  }

  // Patreon identity responses return `member` resources in `included`, with the
  // `campaign` and `currently_entitled_tiers` relationships used below to normalize
  // buyer membership entitlements:
  // https://docs.patreon.com/#get-api-oauth2-v2-identity
  const memberships = (response.included ?? [])
    .filter(
      (
        included
      ): included is PatreonJsonApiResource<PatreonMemberAttributes> & { type: 'member' } =>
        included.type === 'member'
    )
    .map((membership) => ({
      id: membership.id,
      campaignId: getSingleRelationshipId(membership, 'campaign'),
      entitledTierIds: getRelationshipIds(membership, 'currently_entitled_tiers'),
      lastChargeDate: membership.attributes?.last_charge_date ?? undefined,
      lastChargeStatus: membership.attributes?.last_charge_status ?? undefined,
      patronStatus: membership.attributes?.patron_status ?? undefined,
      pledgeRelationshipStart: membership.attributes?.pledge_relationship_start ?? undefined,
    }));

  const vanity = user.attributes?.vanity?.trim();
  return {
    providerUserId: user.id,
    username: vanity || undefined,
    email: user.attributes?.email ?? undefined,
    avatarUrl: user.attributes?.image_url ?? user.attributes?.thumb_url ?? undefined,
    profileUrl: user.attributes?.url ?? (vanity ? `https://www.patreon.com/${vanity}` : undefined),
    memberships,
  };
}

function normalizeCampaignName(campaignId: string, attributes?: PatreonCampaignAttributes): string {
  const creationName = attributes?.creation_name?.trim();
  if (creationName) {
    return creationName;
  }
  return `Campaign ${campaignId}`;
}

function decodeHtmlEntity(entity: string): string {
  const named = HTML_ENTITY_REPLACEMENTS[entity];
  if (named) {
    return named;
  }

  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const parsed = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : `&${entity};`;
  }

  if (entity.startsWith('#')) {
    const parsed = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : `&${entity};`;
  }

  return `&${entity};`;
}

function normalizePatreonTierDescription(description?: string | null): string | undefined {
  if (!description) {
    return undefined;
  }

  const plainText = description
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([^;]+);/g, (_, entity: string) => decodeHtmlEntity(entity))
    .replace(/\s+/g, ' ')
    .trim();

  return plainText || undefined;
}

export function createPatreonProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: PatreonRuntimePorts<TClient>): PatreonProviderRuntime<TClient> {
  return {
    id: 'patreon',
    needsCredential: true,
    purposes: PATREON_PURPOSES,
    displayMeta: PATREON_DISPLAY_META,
    async getCredential(ctx) {
      const encryptedToken = await ports.getEncryptedCredential(ctx);
      if (!encryptedToken) {
        return null;
      }
      return await ports.decryptCredential(encryptedToken, ctx);
    },
    async fetchProducts(credential): Promise<ProductRecord[]> {
      if (!credential) {
        return [];
      }

      // Patreon campaign catalog: GET /api/oauth2/v2/campaigns
      // https://docs.patreon.com/#get-api-oauth2-v2-campaigns
      const url = new URL(`${PATREON_API_BASE}/campaigns`);
      url.searchParams.set('fields[campaign]', 'creation_name,summary,url,patron_count');

      const response = await fetchPatreonJson<PatreonCampaignAttributes>(credential, url, ports);
      const campaigns = Array.isArray(response.data) ? response.data : [response.data];
      return campaigns
        .filter((campaign) => campaign.type === 'campaign')
        .map((campaign) => ({
          id: campaign.id,
          name: normalizeCampaignName(campaign.id, campaign.attributes),
          productUrl: campaign.attributes?.url ?? undefined,
          patronCount:
            typeof campaign.attributes?.patron_count === 'number'
              ? campaign.attributes.patron_count
              : undefined,
        }));
    },
    tiers: {
      async listProductTiers(credential, campaignId): Promise<ProviderTierRecord[]> {
        if (!credential) {
          return [];
        }

        // Patreon campaign tiers are returned via GET /api/oauth2/v2/campaigns/{campaign_id}
        // with include=tiers and explicit tier fields.
        // https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id
        const url = new URL(`${PATREON_API_BASE}/campaigns/${encodeURIComponent(campaignId)}`);
        url.searchParams.set('include', 'tiers');
        url.searchParams.set(
          'fields[tier]',
          'title,description,amount_cents,discord_role_ids,patron_count,published,url'
        );

        const response = await fetchPatreonJson<PatreonCampaignAttributes>(credential, url, ports);
        // The included `tier` resources on this endpoint document the fields read below:
        // `title`, `description`, `amount_cents`, `discord_role_ids`, `patron_count`,
        // `published`, and `url`.
        // https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id
        return (response.included ?? [])
          .filter(
            (
              included
            ): included is { id: string; type: 'tier'; attributes?: PatreonTierAttributes } =>
              included.type === 'tier'
          )
          .map((tier) => ({
            id: tier.id,
            productId: campaignId,
            name: tier.attributes?.title?.trim() || `Tier ${tier.id}`,
            description: normalizePatreonTierDescription(tier.attributes?.description),
            amountCents:
              typeof tier.attributes?.amount_cents === 'number'
                ? tier.attributes.amount_cents
                : undefined,
            currency: 'USD',
            active: tier.attributes?.published ?? undefined,
            metadata: {
              provider: 'patreon',
              discordRoleIds: tier.attributes?.discord_role_ids ?? [],
              patronCount:
                typeof tier.attributes?.patron_count === 'number'
                  ? tier.attributes.patron_count
                  : undefined,
              url: tier.attributes?.url ?? undefined,
            },
          }));
      },
    },
  };
}
