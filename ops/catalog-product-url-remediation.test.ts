import { describe, expect, test } from 'bun:test';
import {
  buildCatalogProductUrlRemediationCommand,
  parseCatalogProductUrlRemediationOptions,
} from './catalog-product-url-remediation';

describe('catalog-product-url-remediation', () => {
  test('builds a dry-run repair command by default', () => {
    const options = parseCatalogProductUrlRemediationOptions([]);
    expect(buildCatalogProductUrlRemediationCommand(options, null)).toEqual([
      'bun',
      'x',
      'convex',
      'run',
      '--typecheck',
      'enable',
      'migrations:repairCatalogProductCanonicalUrls',
      '{"apply":false,"cursor":null,"limit":100}',
    ]);
  });

  test('builds an apply command with a resume cursor and custom page size', () => {
    const options = parseCatalogProductUrlRemediationOptions([
      '--apply',
      '--cursor',
      'cursor-abc',
      '--limit',
      '200',
      '--maxPages',
      '5',
    ]);
    expect(options).toMatchObject({ apply: true, cursor: 'cursor-abc', limit: 200, maxPages: 5 });
    expect(buildCatalogProductUrlRemediationCommand(options, options.cursor)).toEqual([
      'bun',
      'x',
      'convex',
      'run',
      '--typecheck',
      'enable',
      'migrations:repairCatalogProductCanonicalUrls',
      '{"apply":true,"cursor":"cursor-abc","limit":200}',
    ]);
  });

  test('rejects production mode and invalid numeric options', () => {
    expect(() => parseCatalogProductUrlRemediationOptions(['--prod'])).toThrow(
      '--prod is intentionally unsupported'
    );
    expect(() => parseCatalogProductUrlRemediationOptions(['--limit', '0'])).toThrow(
      'Invalid --limit value'
    );
    expect(() => parseCatalogProductUrlRemediationOptions(['--maxPages=-1'])).toThrow(
      'Invalid --maxPages value'
    );
  });
});
