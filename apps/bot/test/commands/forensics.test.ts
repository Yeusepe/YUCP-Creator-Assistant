import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ChatInputCommandInteraction } from 'discord.js';

mock.module('../../src/lib/apiUrls', () => ({
  getApiUrls: mock(() => ({
    apiInternal: process.env.API_INTERNAL_URL ?? process.env.API_BASE_URL,
    apiPublic: process.env.API_BASE_URL,
    webPublic: process.env.FRONTEND_URL ?? process.env.VERIFY_BASE_URL,
  })),
}));

import { handleForensicsLookup } from '../../src/commands/forensics';
import { mockSlashCommand } from '../helpers/mockInteraction';

const originalFetch = globalThis.fetch;
const originalApiBaseUrl = process.env.API_BASE_URL;
const originalApiInternalUrl = process.env.API_INTERNAL_URL;
const originalFrontendUrl = process.env.FRONTEND_URL;
const originalVerifyBaseUrl = process.env.VERIFY_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;

type MockAttachment = {
  contentType?: string | null;
  name?: string | null;
  size: number;
  url: string;
};

function attachLookupOptions(
  interaction: ReturnType<typeof mockSlashCommand>,
  attachment: MockAttachment
) {
  (
    interaction.options as typeof interaction.options & {
      getAttachment: (name: string, required?: boolean) => MockAttachment | null;
    }
  ).getAttachment = (_name: string) => attachment;
  return interaction;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.API_BASE_URL = originalApiBaseUrl;
  process.env.API_INTERNAL_URL = originalApiInternalUrl;
  process.env.FRONTEND_URL = originalFrontendUrl;
  process.env.VERIFY_BASE_URL = originalVerifyBaseUrl;
  process.env.NODE_ENV = originalNodeEnv;
});

describe('forensics command', () => {
  it('uses coupling wording when the API base URL is missing', async () => {
    delete process.env.API_BASE_URL;
    delete process.env.API_INTERNAL_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.VERIFY_BASE_URL;
    process.env.NODE_ENV = 'test';

    const interaction = attachLookupOptions(
      mockSlashCommand({
        commandName: 'creator-admin',
        guildId: 'guild_1',
        stringOptions: {
          package_id: 'creator.package',
        },
        subcommand: 'lookup',
        subcommandGroup: 'forensics',
      }),
      {
        name: 'upload.zip',
        size: 128,
        url: 'https://cdn.example.test/upload.zip',
      }
    );

    await handleForensicsLookup(interaction as unknown as ChatInputCommandInteraction, {
      authUserId: 'auth-user-1',
      guildId: 'guild_1',
    });

    const reply = interaction.editReply.mock.calls[0]?.[0];
    expect(reply?.content).toContain('coupling lookups');
  });

  it('surfaces coupling traceability wording when billing is required', async () => {
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.API_INTERNAL_URL = 'https://api.example.test';
    process.env.FRONTEND_URL = 'https://web.example.test';
    process.env.NODE_ENV = 'test';

    const interaction = attachLookupOptions(
      mockSlashCommand({
        commandName: 'creator-admin',
        guildId: 'guild_1',
        stringOptions: {
          package_id: 'creator.package',
        },
        subcommand: 'lookup',
        subcommandGroup: 'forensics',
      }),
      {
        contentType: 'application/zip',
        name: 'upload-<@123>.zip',
        size: 128,
        url: 'https://cdn.example.test/upload.zip',
      }
    );

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === 'https://cdn.example.test/upload.zip') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }

      if (url === 'https://api.example.test/api/forensics/lookup') {
        return new Response(
          JSON.stringify({
            code: 'coupling_traceability_required',
            error: 'Creator Studio+ is required for coupling traceability',
          }),
          {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await handleForensicsLookup(interaction as unknown as ChatInputCommandInteraction, {
      authUserId: 'auth-user-1',
      guildId: 'guild_1',
    });

    const reply = interaction.editReply.mock.calls[0]?.[0];
    expect(reply?.content).toContain('coupling traceability');
    expect(reply?.content).toContain('https://web.example.test/dashboard/packages?view=forensics');
  });

  it('renders attributed matches with bot-safe buyer fields', async () => {
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.API_INTERNAL_URL = 'https://api.example.test';
    process.env.FRONTEND_URL = 'https://web.example.test';
    process.env.NODE_ENV = 'test';

    const interaction = attachLookupOptions(
      mockSlashCommand({
        commandName: 'creator-admin',
        guildId: 'guild_1',
        stringOptions: {
          package_id: 'creator.package',
        },
        subcommand: 'lookup',
        subcommandGroup: 'forensics',
      }),
      {
        contentType: 'application/zip',
        name: 'upload\npwned-file.zip',
        size: 128,
        url: 'https://cdn.example.test/upload.zip',
      }
    );

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === 'https://cdn.example.test/upload.zip') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }

      if (url === 'https://api.example.test/api/forensics/lookup') {
        return new Response(
          JSON.stringify({
            packageId: 'creator.package<@123>\npwned-package',
            lookupStatus: 'attributed',
            message: 'Matched stored coupling traces',
            candidateAssetCount: 1,
            decodedAssetCount: 1,
            results: [
              {
                assetPath: 'Assets/Character/<@123>body.png\r\npwned-asset',
                assetType: 'png',
                decoderKind: 'png',
                tokenLength: 8,
                layerBClassification: 'trace-recovered',
                matched: true,
                matches: [
                  {
                    matchId: 'a'.repeat(64),
                    buyerMatchId: 'b'.repeat(64),
                    assetPath: 'Assets/Character/<@123>body.png\r\npwned-asset',
                    createdAt: 1_739_999_999_000,
                    runtimeArtifactVersion: '2026.03.25.153000',
                    licenseMasked: 'jinxxy · ffffffff',
                    buyerProviderUsername: '<@123> **BuyerAccount**\r\npwned-buyer @everyone',
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await handleForensicsLookup(interaction as unknown as ChatInputCommandInteraction, {
      authUserId: 'auth-user-1',
      guildId: 'guild_1',
    });

    const reply = interaction.editReply.mock.calls[0]?.[0];
    const content = reply?.content ?? '';
    expect(reply?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Matched buyers: 1');
    expect(content).toContain('BuyerAccount');
    expect(content).not.toContain('<@123>');
    expect(content).not.toContain('@everyone');
    expect(content).not.toContain('**BuyerAccount**');
    expect(content).not.toContain('\r');
    expect(content).not.toContain('\npwned-package');
    expect(content).not.toContain('\npwned-file');
    expect(content).not.toContain('\npwned-asset');
    expect(content).not.toContain('\npwned-buyer');
    expect(content).not.toContain('undefined');
  });

  it('counts all matched buyers and deduplicates top match details', async () => {
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.API_INTERNAL_URL = 'https://api.example.test';
    process.env.FRONTEND_URL = 'https://web.example.test';
    process.env.NODE_ENV = 'test';

    const interaction = attachLookupOptions(
      mockSlashCommand({
        commandName: 'creator-admin',
        guildId: 'guild_1',
        stringOptions: {
          package_id: 'creator.package',
        },
        subcommand: 'lookup',
        subcommandGroup: 'forensics',
      }),
      {
        contentType: 'application/zip',
        name: 'upload.zip',
        size: 128,
        url: 'https://cdn.example.test/upload.zip',
      }
    );

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === 'https://cdn.example.test/upload.zip') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }

      if (url === 'https://api.example.test/api/forensics/lookup') {
        return new Response(
          JSON.stringify({
            packageId: 'creator.package',
            lookupStatus: 'attributed',
            message: 'Matched stored coupling traces',
            candidateAssetCount: 6,
            decodedAssetCount: 6,
            results: [
              ...Array.from({ length: 5 }, (_, index) => ({
                assetPath: `Assets/Character/duplicate-${index}.png`,
                assetType: 'png',
                decoderKind: 'png',
                tokenLength: 8,
                layerBClassification: 'trace-recovered',
                matched: true,
                matches: [
                  {
                    matchId: `${index}`.repeat(64).slice(0, 64),
                    buyerMatchId: 'b'.repeat(64),
                    assetPath: `Assets/Character/duplicate-${index}.png`,
                    createdAt: 1_739_999_999_000 + index,
                    licenseMasked: 'license-a',
                    buyerProviderUsername: 'BuyerOne',
                  },
                ],
              })),
              {
                assetPath: 'Assets/Character/unique.png',
                assetType: 'png',
                decoderKind: 'png',
                tokenLength: 8,
                layerBClassification: 'trace-recovered',
                matched: true,
                matches: [
                  {
                    matchId: 'c'.repeat(64),
                    buyerMatchId: 'd'.repeat(64),
                    assetPath: 'Assets/Character/unique.png',
                    createdAt: 1_740_000_000_000,
                    licenseMasked: 'license-b',
                    buyerProviderUsername: 'BuyerTwo',
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await handleForensicsLookup(interaction as unknown as ChatInputCommandInteraction, {
      authUserId: 'auth-user-1',
      guildId: 'guild_1',
    });

    const reply = interaction.editReply.mock.calls[0]?.[0];
    const content = reply?.content ?? '';
    expect(content).toContain('Matched buyers: 2');
    expect(content).toContain('BuyerTwo');
    expect(content.match(/BuyerOne/g)?.length).toBe(1);
  });
});
