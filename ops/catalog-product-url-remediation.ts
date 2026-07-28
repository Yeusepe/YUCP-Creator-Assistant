/**
 * Detection-first remediation helper for catalog product canonical URLs.
 *
 * Drives migrations:repairCatalogProductCanonicalUrls, which repairs legacy
 * template-plus-providerProductRef links (example.invalid placeholders,
 * jinxxy.app/uuid, app.lemonsqueezy.com dashboard URLs, vrchat.com/store,
 * gumroad.com/l/{api-id}) using the stored canonical slug, inserts missing
 * slug-derivable links, deletes unfixable junk links, and reports products
 * that need a catalog re-sync so the provider API URL gets stored.
 *
 * Usage:
 *   bun run ops:catalog-product-url-remediation
 *   bun run ops:catalog-product-url-remediation -- --limit 200 --maxPages 5
 *   bun run ops:catalog-product-url-remediation -- --apply
 */

import { parseArgs } from 'node:util';
import { buildBunToolCommand } from './cli-utils';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 25;

export type CatalogProductUrlRemediationOptions = {
  apply: boolean;
  cursor: string | null;
  help: boolean;
  limit: number;
  maxPages: number;
};

function printUsage(): void {
  console.log(
    [
      'catalog-product-url-remediation',
      '',
      'Usage:',
      '  bun run ops:catalog-product-url-remediation',
      '  bun run ops:catalog-product-url-remediation -- --limit 200 --maxPages 5',
      '  bun run ops:catalog-product-url-remediation -- --apply',
      '',
      'Options:',
      '  --limit <number>    Page size per migration call. Default: 100.',
      '  --maxPages <number> Safety bound on paginated calls per run. Default: 25.',
      '  --cursor <cursor>   Resume from a previously returned continueCursor.',
      '  --apply             Execute repairs. Default is dry-run reporting only.',
      '  --help              Show this message.',
      '',
      'Safety:',
      '  This tool intentionally refuses --prod. Run it only against a reviewed non-prod deployment first.',
      '  Dry-run mode is the default. No data is mutated unless --apply is set.',
      '  Products reported under needsResyncProducts require a catalog re-sync',
      '  (bot autosetup or product add) so the provider API product URL is stored.',
    ].join('\n')
  );
}

export function parseCatalogProductUrlRemediationOptions(
  argv: readonly string[]
): CatalogProductUrlRemediationOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: 'boolean', default: false },
      cursor: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      limit: { type: 'string' },
      maxPages: { type: 'string' },
      prod: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.prod) {
    throw new Error('--prod is intentionally unsupported for catalog product URL remediation');
  }

  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit value: ${values.limit}`);
  }
  const maxPages = values.maxPages ? Number.parseInt(values.maxPages, 10) : DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`Invalid --maxPages value: ${values.maxPages}`);
  }

  return {
    apply: values.apply,
    cursor: values.cursor?.trim() || null,
    help: values.help,
    limit,
    maxPages,
  };
}

export function buildCatalogProductUrlRemediationCommand(
  options: CatalogProductUrlRemediationOptions,
  cursor: string | null
): string[] {
  return buildBunToolCommand('convex', [
    'run',
    '--typecheck',
    'enable',
    'migrations:repairCatalogProductCanonicalUrls',
    JSON.stringify({
      apply: options.apply,
      cursor,
      limit: options.limit,
    }),
  ]);
}

type RepairPageResult = {
  continueCursor: string | null;
  isDone: boolean;
  scanned: number;
  repaired: number;
  inserted: number;
  junkRemoved: number;
  untouched: number;
  needsResync: number;
  needsResyncProducts: Array<{
    catalogProductId: string;
    authUserId: string;
    provider: string;
    providerProductRef: string;
  }>;
};

async function readProcessOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

async function runRepairPage(
  options: CatalogProductUrlRemediationOptions,
  cursor: string | null
): Promise<RepairPageResult> {
  const proc = Bun.spawn({
    cmd: buildCatalogProductUrlRemediationCommand(options, cursor),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(proc.stdout),
    readProcessOutput(proc.stderr),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `Convex remediation command failed with exit code ${exitCode}`
    );
  }

  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    throw new Error('Convex remediation command returned no JSON payload');
  }

  return JSON.parse(lastLine) as RepairPageResult;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCatalogProductUrlRemediationOptions(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const totals = {
    apply: options.apply,
    pages: 0,
    scanned: 0,
    repaired: 0,
    inserted: 0,
    junkRemoved: 0,
    untouched: 0,
    needsResync: 0,
    needsResyncProducts: [] as RepairPageResult['needsResyncProducts'],
    exhausted: true,
  };

  let cursor = options.cursor;
  for (let page = 0; page < options.maxPages; page++) {
    const result = await runRepairPage(options, cursor);
    totals.pages++;
    totals.scanned += result.scanned;
    totals.repaired += result.repaired;
    totals.inserted += result.inserted;
    totals.junkRemoved += result.junkRemoved;
    totals.untouched += result.untouched;
    totals.needsResync += result.needsResync;
    totals.needsResyncProducts.push(...result.needsResyncProducts);
    if (result.isDone) {
      cursor = null;
      break;
    }
    cursor = result.continueCursor;
  }

  if (cursor) {
    totals.exhausted = false;
    console.log(
      `[catalog-product-url-remediation] stopped at page bound; resume with --cursor ${JSON.stringify(cursor)}`
    );
  }
  console.log(
    options.apply
      ? '[catalog-product-url-remediation] applied canonical URL repairs'
      : '[catalog-product-url-remediation] generated dry-run repair report'
  );
  console.log(JSON.stringify(totals, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[catalog-product-url-remediation]', error);
    process.exit(1);
  });
}
