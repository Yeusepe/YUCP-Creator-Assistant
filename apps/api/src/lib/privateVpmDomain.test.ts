import { describe, expect, it, mock } from 'bun:test';
import {
  buildPrivateVpmBaseUrl,
  CloudflarePrivateVpmDomainProvisioner,
  createConfiguredPrivateVpmDomainProvisioner,
  createPrivateVpmSlugCandidates,
  normalizePrivateVpmRootDomain,
} from './privateVpmDomain';

describe('private VPM creator domains', () => {
  it('builds only creator-scoped HTTPS origins from valid private-domain inputs', () => {
    expect(normalizePrivateVpmRootDomain(' Private.YUCP.Club. ')).toBe('private.yucp.club');
    expect(buildPrivateVpmBaseUrl('private.yucp.club', 'Mapache')).toBe(
      'https://mapache.private.yucp.club'
    );
    expect(buildPrivateVpmBaseUrl('https://private.yucp.club', 'mapache')).toBeNull();
    expect(buildPrivateVpmBaseUrl('private.yucp.club', 'invalid_slug')).toBeNull();
    expect(buildPrivateVpmBaseUrl(undefined, 'mapache')).toBeNull();
  });

  it('requires the purpose-scoped Cloudflare configuration as one complete unit', () => {
    expect(createConfiguredPrivateVpmDomainProvisioner({})).toBeUndefined();
    expect(() =>
      createConfiguredPrivateVpmDomainProvisioner({
        PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID: 'account-id',
      })
    ).toThrow('configuration is incomplete');
    expect(
      createConfiguredPrivateVpmDomainProvisioner({
        PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID: 'account-id',
        PRIVATE_VPM_CLOUDFLARE_API_TOKEN: 'private-vpm-token',
        PRIVATE_VPM_CLOUDFLARE_SERVICE: 'creator-assistant-dashboard',
        PRIVATE_VPM_CLOUDFLARE_ZONE_ID: 'club-zone',
        PRIVATE_VPM_CLOUDFLARE_ZONE_NAME: 'yucp.club',
      })
    ).toBeInstanceOf(CloudflarePrivateVpmDomainProvisioner);
  });

  it('creates stable, DNS-safe creator slug candidates', () => {
    expect(createPrivateVpmSlugCandidates('Mápache Studio', 'creator-auth-user')).toEqual([
      'mapache-studio',
      'mapache-studio-6936a0ffea',
      'creator-6936a0ffea66047a',
    ]);
  });

  it('returns an existing exact Worker Custom Domain without replacing it', async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 'domain-id',
            cert_id: 'certificate-id',
            hostname: 'mapache.private.yucp.club',
            service: 'creator-assistant-dashboard',
            zone_id: 'club-zone',
            zone_name: 'yucp.club',
            environment: 'production',
          },
        ],
      })
    );
    const provisioner = new CloudflarePrivateVpmDomainProvisioner({
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      service: 'creator-assistant-dashboard',
      zoneId: 'club-zone',
      zoneName: 'yucp.club',
    });

    await expect(provisioner.ensureDomain('mapache.private.yucp.club')).resolves.toEqual({
      hostname: 'mapache.private.yucp.club',
      status: 'active',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('attaches a missing exact Worker Custom Domain and validates the response', async () => {
    const fetchImpl = mock()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            id: 'domain-id',
            cert_id: 'certificate-id',
            hostname: 'mapache.private.yucp.club',
            service: 'creator-assistant-dashboard',
            zone_id: 'club-zone',
            zone_name: 'yucp.club',
            environment: 'production',
          },
        })
      );
    const provisioner = new CloudflarePrivateVpmDomainProvisioner({
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      service: 'creator-assistant-dashboard',
      zoneId: 'club-zone',
      zoneName: 'yucp.club',
    });

    await expect(provisioner.ensureDomain('mapache.private.yucp.club')).resolves.toEqual({
      hostname: 'mapache.private.yucp.club',
      status: 'active',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-id/workers/domains');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-token');
    expect(JSON.parse(String(init.body))).toEqual({
      hostname: 'mapache.private.yucp.club',
      service: 'creator-assistant-dashboard',
      zone_id: 'club-zone',
      zone_name: 'yucp.club',
    });
  });

  it('rejects a hostname already attached to another Worker', async () => {
    const provisioner = new CloudflarePrivateVpmDomainProvisioner({
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl: (async () =>
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            {
              id: 'domain-id',
              cert_id: 'certificate-id',
              hostname: 'mapache.private.yucp.club',
              service: 'another-worker',
              zone_id: 'club-zone',
              zone_name: 'yucp.club',
            },
          ],
        })) as unknown as typeof fetch,
      service: 'creator-assistant-dashboard',
      zoneId: 'club-zone',
      zoneName: 'yucp.club',
    });

    await expect(provisioner.ensureDomain('mapache.private.yucp.club')).rejects.toThrow(
      'already attached to another Worker'
    );
  });
});
