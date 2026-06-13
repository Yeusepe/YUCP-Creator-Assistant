import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type BackstageRepoAccess = {
  repositoryUrl: string;
  repositoryHeaders: Record<string, string>;
};

type BackstageRepoTestConfig = BackstageRepoAccess & {
  packageDir?: string;
};

type FixturePackage = {
  fileName: string;
  label: string;
  version: string;
};

type RepositoryVersionManifest = {
  name?: string;
  version?: string;
  displayName?: string;
  url?: string;
  headers?: Record<string, string>;
};

type FlattenedRepositoryPackage = {
  packageId: string;
  version: string;
  displayName: string;
  url: string;
  headers: Record<string, string>;
};

type BackstageRepoSmokeResult = {
  repositoryUrl: string;
  repositoryPackageCount: number;
  checkedPackageUrls: string[];
  fixtureMatches: Array<FixturePackage & { packageId: string }>;
};

const FIXTURE_FILE_PATTERN =
  /^(?<label>.+)_(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.(?<extension>unitypackage|zip)$/i;

function assertNonEmpty(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeMatchKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseHeaderEntry(entry: string): [string, string] {
  const separator = entry.indexOf(':');
  if (separator < 1) {
    throw new Error(`Invalid repository header "${entry}". Use Name:Value.`);
  }

  const name = entry.slice(0, separator).trim();
  const value = entry.slice(separator + 1).trim();
  if (!name || !value) {
    throw new Error(`Invalid repository header "${entry}". Use Name:Value.`);
  }
  return [name, value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getManifestHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function parseAddRepoUrl(addRepoUrl: string): BackstageRepoAccess {
  const parsed = new URL(assertNonEmpty(addRepoUrl, 'Backstage add-repo url is required.'));
  if (parsed.protocol !== 'vcc:' || parsed.hostname !== 'vpm' || parsed.pathname !== '/addRepo') {
    throw new Error('Backstage add-repo url must use the vcc://vpm/addRepo format.');
  }

  const repositoryUrl = assertNonEmpty(
    parsed.searchParams.get('url') ?? undefined,
    'Backstage add-repo url is missing the repository url.'
  );

  const repositoryHeaders = Object.fromEntries(
    parsed.searchParams
      .getAll('headers[]')
      .map(parseHeaderEntry)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  return {
    repositoryHeaders,
    repositoryUrl,
  };
}

export function collectFixturePackages(packageDir: string): FixturePackage[] {
  const resolvedDir = resolve(assertNonEmpty(packageDir, 'Package fixture directory is required.'));
  return readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(FIXTURE_FILE_PATTERN);
      if (!match?.groups) {
        return null;
      }

      return {
        fileName: entry.name,
        label: match.groups.label.trim(),
        version: match.groups.version,
      } satisfies FixturePackage;
    })
    .filter((entry): entry is FixturePackage => entry !== null)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function flattenRepositoryPackages(
  repositoryDocument: unknown,
  repositoryHeaders: Record<string, string>
): FlattenedRepositoryPackage[] {
  if (!isRecord(repositoryDocument) || !isRecord(repositoryDocument.packages)) {
    throw new Error('Repository document is missing the packages map.');
  }

  const flattened: FlattenedRepositoryPackage[] = [];
  for (const [packageId, packageEntry] of Object.entries(repositoryDocument.packages)) {
    if (!isRecord(packageEntry) || !isRecord(packageEntry.versions)) {
      continue;
    }

    for (const [version, manifestValue] of Object.entries(packageEntry.versions)) {
      const manifest = manifestValue as RepositoryVersionManifest;
      if (typeof manifest.url !== 'string' || !manifest.url) {
        continue;
      }

      flattened.push({
        packageId,
        version,
        displayName:
          typeof manifest.displayName === 'string' && manifest.displayName.trim().length > 0
            ? manifest.displayName.trim()
            : typeof manifest.name === 'string' && manifest.name.trim().length > 0
              ? manifest.name.trim()
              : packageId,
        headers: {
          ...repositoryHeaders,
          ...getManifestHeaders(manifest.headers),
        },
        url: manifest.url,
      });
    }
  }

  return flattened.sort((left, right) =>
    `${left.displayName}@${left.version}`.localeCompare(`${right.displayName}@${right.version}`)
  );
}

function findFixtureMatches(
  fixtures: FixturePackage[],
  repositoryPackages: FlattenedRepositoryPackage[]
): Array<FixturePackage & { packageId: string }> {
  const packageLookup = new Map(
    repositoryPackages.map((pkg) => [`${normalizeMatchKey(pkg.displayName)}@${pkg.version}`, pkg] as const)
  );
  const matches: Array<FixturePackage & { packageId: string }> = [];
  const missing: FixturePackage[] = [];

  for (const fixture of fixtures) {
    const match = packageLookup.get(`${normalizeMatchKey(fixture.label)}@${fixture.version}`);
    if (!match) {
      missing.push(fixture);
      continue;
    }

    matches.push({
      ...fixture,
      packageId: match.packageId,
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `Repository is missing fixture versions: ${missing
        .map((fixture) => `${fixture.label}@${fixture.version}`)
        .join(', ')}`
    );
  }

  return matches;
}

export async function runBackstageRepoSmokeTest(
  config: BackstageRepoTestConfig,
  fetchImpl: typeof fetch = fetch
): Promise<BackstageRepoSmokeResult> {
  const repositoryResponse = await fetchImpl(config.repositoryUrl, {
    headers: config.repositoryHeaders,
  });

  if (!repositoryResponse.ok) {
    throw new Error(
      `Failed to fetch repository document (${repositoryResponse.status} ${repositoryResponse.statusText}).`
    );
  }

  const repositoryDocument = await repositoryResponse.json();
  const repositoryPackages = flattenRepositoryPackages(
    repositoryDocument,
    config.repositoryHeaders
  );

  if (repositoryPackages.length === 0) {
    throw new Error('Repository document did not expose any package versions.');
  }

  const checkedPackageUrls: string[] = [];
  for (const repositoryPackage of repositoryPackages) {
    const packageResponse = await fetchImpl(repositoryPackage.url, {
      headers: repositoryPackage.headers,
      redirect: 'manual',
    });
    if (!(packageResponse.ok || (packageResponse.status >= 300 && packageResponse.status < 400))) {
      throw new Error(
        `Package request failed for ${repositoryPackage.packageId}@${repositoryPackage.version} (${packageResponse.status} ${packageResponse.statusText}).`
      );
    }

    checkedPackageUrls.push(repositoryPackage.url);
  }

  const fixtures = config.packageDir ? collectFixturePackages(config.packageDir) : [];
  const fixtureMatches = fixtures.length > 0 ? findFixtureMatches(fixtures, repositoryPackages) : [];

  return {
    checkedPackageUrls,
    fixtureMatches,
    repositoryPackageCount: repositoryPackages.length,
    repositoryUrl: config.repositoryUrl,
  };
}

export function resolveBackstageRepoTestConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): BackstageRepoTestConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      addRepoUrl: {
        type: 'string',
      },
      packageDir: {
        type: 'string',
      },
      repoToken: {
        type: 'string',
      },
      repoTokenHeader: {
        type: 'string',
      },
      repositoryUrl: {
        type: 'string',
      },
    },
    allowPositionals: false,
  });

  const addRepoUrl = values.addRepoUrl ?? env.YUCP_BACKSTAGE_ADD_REPO_URL;
  const packageDir = values.packageDir ?? env.YUCP_BACKSTAGE_PACKAGE_DIR;

  if (addRepoUrl) {
    return {
      ...parseAddRepoUrl(addRepoUrl),
      ...(packageDir ? { packageDir: resolve(packageDir) } : {}),
    };
  }

  const repositoryUrl = values.repositoryUrl ?? env.YUCP_BACKSTAGE_REPOSITORY_URL;
  const repoToken = values.repoToken ?? env.YUCP_BACKSTAGE_REPO_TOKEN;
  const repoTokenHeader =
    values.repoTokenHeader ?? env.YUCP_BACKSTAGE_REPO_TOKEN_HEADER ?? 'X-YUCP-Repo-Token';

  return {
    packageDir: packageDir ? resolve(packageDir) : undefined,
    repositoryHeaders: repoToken
      ? {
          [repoTokenHeader]: repoToken,
        }
      : {},
    repositoryUrl: assertNonEmpty(
      repositoryUrl,
      'Pass --addRepoUrl or --repositoryUrl to test a Backstage repo.'
    ),
  };
}

export function printUsage(): void {
  console.log(`Usage:
  bun run smoke:backstage-repo -- --addRepoUrl="vcc://vpm/addRepo?..."
  bun run smoke:backstage-repo -- --repositoryUrl="http://localhost:3001/v1/backstage/repos/index.json" --repoToken="ybt_..."

Optional:
  --packageDir="C:\\path\\to\\package-fixtures"

Environment variables:
  YUCP_BACKSTAGE_ADD_REPO_URL
  YUCP_BACKSTAGE_REPOSITORY_URL
  YUCP_BACKSTAGE_REPO_TOKEN
  YUCP_BACKSTAGE_REPO_TOKEN_HEADER
  YUCP_BACKSTAGE_PACKAGE_DIR
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    printUsage();
    return;
  }

  const config = resolveBackstageRepoTestConfig(argv);
  const result = await runBackstageRepoSmokeTest(config);

  console.log(
    JSON.stringify(
      {
        checkedPackageUrls: result.checkedPackageUrls,
        fixtureMatches: result.fixtureMatches,
        packageDir: config.packageDir,
        repositoryPackageCount: result.repositoryPackageCount,
        repositoryUrl: result.repositoryUrl,
      },
      null,
      2
    )
  );
}

if (import.meta.main) {
  await main();
}
