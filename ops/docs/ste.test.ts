import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectProgramDocumentPaths,
  compareWorkItems,
  lintMarkdown,
  runDocumentationGate,
} from './ste';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yucp-docs-ste-'));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, path: string, contents: string): void {
  const absolutePath = join(root, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

function writeRequiredDocuments(root: string): void {
  write(
    root,
    'docs/package-storage-delivery-architecture.md',
    '# Architecture\n\nThe design is bounded.\n'
  );
  write(
    root,
    'docs/package-storage-delivery-implementation-plan.md',
    '# Plan\n\n#### P0-00: Add the documentation gate\n\nRun the gate.\n'
  );
  write(
    root,
    'docs/package-storage-delivery-progress.md',
    '# Progress\n\n| ID | State |\n| --- | --- |\n| P0-00 | READY |\n'
  );
  write(root, 'docs/package-storage-research-ledger.md', '# Research\n\nThe record is current.\n');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ASD-STE100 package documentation gate', () => {
  it('reports prohibited punctuation, contractions, and sentence lengths', () => {
    const markdown = [
      '# Test',
      '',
      "Do not join these instructions; don't add an em dash — to the sentence.",
      '',
      `Use ${Array.from({ length: 20 }, (_, index) => `item${index + 1}`).join(' ')}.`,
      '',
      `The ${Array.from({ length: 25 }, (_, index) => `value${index + 1}`).join(' ')}.`,
    ].join('\n');

    expect(lintMarkdown('docs/test.md', markdown).map(({ rule }) => rule)).toEqual([
      'STE-EM-DASH',
      'STE-SEMICOLON',
      'STE-CONTRACTION',
      'STE-PROCEDURAL-LENGTH',
      'STE-DESCRIPTIVE-LENGTH',
    ]);
  });

  it('ignores fenced code and inline code punctuation', () => {
    const markdown = [
      '# Test',
      '',
      'Use `const value = "don\'t";` in the example.',
      '',
      '```ts',
      'const value = "don\'t";',
      '```',
    ].join('\n');

    expect(lintMarkdown('docs/test.md', markdown)).toEqual([]);
  });

  it('ignores multiline HTML comments', () => {
    const markdown = [
      '# Test',
      '',
      '<!--',
      "Do not report this hidden sentence; don't report its punctuation.",
      '-->',
      '',
      'The visible sentence is compliant.',
    ].join('\n');

    expect(lintMarkdown('docs/test.md', markdown)).toEqual([]);
  });

  it('reports missing, extra, and duplicate work items', () => {
    const plan = ['#### P0-00: First', '#### P0-01: Second', '#### P0-01: Duplicate'].join('\n');
    const progress = ['| P0-00 | READY |', '| P0-02 | NOT STARTED |'].join('\n');

    expect(
      compareWorkItems('docs/plan.md', plan, 'docs/progress.md', progress).map(({ rule }) => rule)
    ).toEqual(['WORK-ITEM-DUPLICATE', 'WORK-ITEM-MISSING', 'WORK-ITEM-MISSING', 'WORK-ITEM-EXTRA']);
  });

  it('collects only the explicit program documents and nested program directory', () => {
    const root = temporaryRoot();
    writeRequiredDocuments(root);
    write(root, 'docs/package-storage-delivery/reviews/one.md', '# Review\n');
    write(root, 'docs/reinventing-the-wheel-audit.md', '# Unrelated\n');

    const paths = collectProgramDocumentPaths(root).map((path) =>
      path.slice(root.length + 1).replaceAll('\\', '/')
    );

    expect(paths).toContain('docs/package-storage-delivery/reviews/one.md');
    expect(paths).not.toContain('docs/reinventing-the-wheel-audit.md');
    expect(paths).toHaveLength(5);
  });

  it('passes a complete compliant package document set', () => {
    const root = temporaryRoot();
    writeRequiredDocuments(root);

    expect(runDocumentationGate(root)).toEqual([]);
  });
});
