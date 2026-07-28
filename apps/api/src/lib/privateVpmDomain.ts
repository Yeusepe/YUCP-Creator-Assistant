import { createHash } from 'node:crypto';

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_CREATOR_SLUGS = new Set([
  'admin',
  'api',
  'mail',
  'private',
  'status',
  'support',
  'www',
]);

type CloudflareDomain = {
  cert_id: string;
  environment?: string;
  hostname: string;
  id: string;
  service: string;
  zone_id: string;
  zone_name: string;
};

type CloudflareEnvelope<T> = {
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result?: T;
  success: boolean;
};

export interface PrivateVpmDomainProvisioner {
  ensureDomain(hostname: string): Promise<{
    hostname: string;
    status: 'active';
  }>;
}

export function normalizePrivateVpmRootDomain(value?: string): string | null {
  const rootDomain = value?.trim().toLowerCase().replace(/\.$/, '');
  if (
    !rootDomain ||
    rootDomain.length > 253 ||
    rootDomain.split('.').some((label) => !DNS_LABEL_PATTERN.test(label))
  ) {
    return null;
  }
  return rootDomain;
}

export function buildPrivateVpmBaseUrl(
  rootDomainInput: string | undefined,
  creatorSlugInput: string | undefined
): string | null {
  const rootDomain = normalizePrivateVpmRootDomain(rootDomainInput);
  const creatorSlug = creatorSlugInput?.trim().toLowerCase();
  if (!rootDomain || !creatorSlug || !DNS_LABEL_PATTERN.test(creatorSlug)) {
    return null;
  }
  const hostname = `${creatorSlug}.${rootDomain}`;
  return hostname.length <= 253 ? `https://${hostname}` : null;
}

export type CloudflarePrivateVpmDomainProvisionerConfig = {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  service: string;
  zoneId: string;
  zoneName: string;
};

type PrivateVpmDomainEnvironment = {
  PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID?: string;
  PRIVATE_VPM_CLOUDFLARE_API_TOKEN?: string;
  PRIVATE_VPM_CLOUDFLARE_SERVICE?: string;
  PRIVATE_VPM_CLOUDFLARE_ZONE_ID?: string;
  PRIVATE_VPM_CLOUDFLARE_ZONE_NAME?: string;
};

function normalizeDnsLabel(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
    .replace(/-+$/g, '');
  if (!normalized || RESERVED_CREATOR_SLUGS.has(normalized)) {
    return 'creator';
  }
  return normalized;
}

export function createPrivateVpmSlugCandidates(creatorName: string, authUserId: string): string[] {
  const base = normalizeDnsLabel(creatorName);
  const digest = createHash('sha256').update(authUserId, 'utf8').digest('hex');
  return [
    ...new Set([
      base,
      `${base.slice(0, 52)}-${digest.slice(0, 10)}`,
      `creator-${digest.slice(0, 16)}`,
    ]),
  ];
}

export function createConfiguredPrivateVpmDomainProvisioner(
  env: PrivateVpmDomainEnvironment
): CloudflarePrivateVpmDomainProvisioner | undefined {
  const values = {
    accountId: env.PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID?.trim(),
    apiToken: env.PRIVATE_VPM_CLOUDFLARE_API_TOKEN?.trim(),
    service: env.PRIVATE_VPM_CLOUDFLARE_SERVICE?.trim(),
    zoneId: env.PRIVATE_VPM_CLOUDFLARE_ZONE_ID?.trim(),
    zoneName: env.PRIVATE_VPM_CLOUDFLARE_ZONE_NAME?.trim(),
  };
  const configuredCount = Object.values(values).filter(Boolean).length;
  if (configuredCount === 0) {
    return undefined;
  }
  if (configuredCount !== Object.keys(values).length) {
    throw new Error('Cloudflare private VPM domain configuration is incomplete');
  }
  return new CloudflarePrivateVpmDomainProvisioner({
    accountId: values.accountId as string,
    apiToken: values.apiToken as string,
    service: values.service as string,
    zoneId: values.zoneId as string,
    zoneName: values.zoneName as string,
  });
}

function assertCloudflareDomain(
  value: unknown,
  expected: {
    hostname: string;
    service: string;
    zoneId: string;
    zoneName: string;
  }
): CloudflareDomain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloudflare returned an invalid Worker Custom Domain');
  }
  const domain = value as Partial<CloudflareDomain>;
  if (
    typeof domain.id !== 'string' ||
    typeof domain.cert_id !== 'string' ||
    domain.hostname !== expected.hostname ||
    domain.service !== expected.service ||
    domain.zone_id !== expected.zoneId ||
    domain.zone_name !== expected.zoneName
  ) {
    throw new Error('Cloudflare returned a mismatched Worker Custom Domain');
  }
  return domain as CloudflareDomain;
}

function cloudflareErrorMessage<T>(envelope: CloudflareEnvelope<T>, fallback: string): string {
  const details = envelope.errors
    ?.map((error) => error.message?.trim())
    .filter((message): message is string => Boolean(message))
    .join('; ');
  return details || fallback;
}

export class CloudflarePrivateVpmDomainProvisioner implements PrivateVpmDomainProvisioner {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetchImpl: typeof fetch;
  readonly #service: string;
  readonly #zoneId: string;
  readonly #zoneName: string;

  constructor(config: CloudflarePrivateVpmDomainProvisionerConfig) {
    this.#accountId = config.accountId.trim();
    this.#apiToken = config.apiToken.trim();
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#service = config.service.trim();
    this.#zoneId = config.zoneId.trim();
    this.#zoneName = config.zoneName.trim().toLowerCase();
    if (!this.#accountId || !this.#apiToken || !this.#service || !this.#zoneId || !this.#zoneName) {
      throw new Error('Cloudflare private VPM domain configuration is incomplete');
    }
  }

  async #readEnvelope<T>(response: Response, operation: string): Promise<CloudflareEnvelope<T>> {
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch (error) {
      throw new Error(`Cloudflare ${operation} returned invalid JSON`, { cause: error });
    }
    if (!response.ok || !envelope.success) {
      throw new Error(
        cloudflareErrorMessage(envelope, `Cloudflare ${operation} failed with ${response.status}`)
      );
    }
    return envelope;
  }

  async ensureDomain(hostnameInput: string): Promise<{
    hostname: string;
    status: 'active';
  }> {
    const hostname = hostnameInput.trim().toLowerCase();
    const labels = hostname.split('.');
    if (
      labels.some((label) => !DNS_LABEL_PATTERN.test(label)) ||
      !hostname.endsWith(`.${this.#zoneName}`)
    ) {
      throw new Error('Private VPM hostname is invalid');
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      this.#accountId
    )}/workers/domains`;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.#apiToken}`,
    };

    // Cloudflare list and attach contracts:
    // https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/
    // https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
    const listUrl = new URL(endpoint);
    listUrl.searchParams.set('hostname', hostname);
    listUrl.searchParams.set('zone_id', this.#zoneId);
    const listed = await this.#readEnvelope<CloudflareDomain[]>(
      await this.#fetchImpl(listUrl, {
        headers,
        method: 'GET',
      }),
      'Worker Custom Domain lookup'
    );
    const existing = listed.result?.find((domain) => domain.hostname === hostname);
    if (existing) {
      const domain = assertCloudflareDomain(existing, {
        hostname,
        service: existing.service,
        zoneId: this.#zoneId,
        zoneName: this.#zoneName,
      });
      if (domain.service !== this.#service) {
        throw new Error('Private VPM hostname is already attached to another Worker');
      }
      return { hostname, status: 'active' };
    }

    const attached = await this.#readEnvelope<CloudflareDomain>(
      await this.#fetchImpl(endpoint, {
        body: JSON.stringify({
          hostname,
          service: this.#service,
          zone_id: this.#zoneId,
          zone_name: this.#zoneName,
        }),
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        method: 'PUT',
      }),
      'Worker Custom Domain attachment'
    );
    assertCloudflareDomain(attached.result, {
      hostname,
      service: this.#service,
      zoneId: this.#zoneId,
      zoneName: this.#zoneName,
    });
    return { hostname, status: 'active' };
  }
}
