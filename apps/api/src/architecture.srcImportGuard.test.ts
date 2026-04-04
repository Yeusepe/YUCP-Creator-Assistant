import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '../../../..');
const workspaceRoots = [join(repoRoot, 'apps'), join(repoRoot, 'packages')];
const runtimeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const resolvableExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

type Workspace = {
  kind: 'apps' | 'packages';
  name: string;
};

function isRuntimeSourceFile(filePath: string): boolean {
  const fileName = filePath.split(sep).at(-1) ?? '';
  if (fileName.endsWith('.d.ts')) {
    return false;
  }

  return runtimeExtensions.has(extname(fileName)) && !/\.(test|spec)\.[^.]+$/.test(fileName);
}

function collectRuntimeFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectRuntimeFiles(fullPath));
      continue;
    }

    if (isRuntimeSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectWorkspaceRuntimeFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];

  for (const workspaceName of readdirSync(root)) {
    const srcDir = join(root, workspaceName, 'src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      continue;
    }

    files.push(...collectRuntimeFiles(srcDir));
  }

  return files;
}

function getWorkspace(filePath: string): Workspace | null {
  const relativePath = relative(repoRoot, filePath);
  if (relativePath.startsWith('..')) {
    return null;
  }

  const [kind, name] = relativePath.split(sep);
  if ((kind === 'apps' || kind === 'packages') && name) {
    return { kind, name };
  }

  return null;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (extname(filePath)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
      return ts.ScriptKind.JS;
    case '.mjs':
      return ts.ScriptKind.JS;
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.mts':
      return ts.ScriptKind.TS;
    case '.cts':
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.TS;
  }
}

function getImportSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );
  const specifiers = new Set<string>();

  function add(specifier: ts.Expression | undefined): void {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      specifiers.add(specifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node.arguments[0]);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return [...specifiers];
}

function resolveImportTarget(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const absoluteBase = resolve(dirname(importerPath), specifier);
  const candidates = extname(absoluteBase)
    ? [absoluteBase]
    : [
        absoluteBase,
        ...resolvableExtensions.map((extension) => `${absoluteBase}${extension}`),
        ...resolvableExtensions.map((extension) => join(absoluteBase, `index${extension}`)),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function isCrossPackageSrcImport(importerPath: string, resolvedTargetPath: string): boolean {
  const importerWorkspace = getWorkspace(importerPath);
  if (!importerWorkspace) {
    return false;
  }

  const targetRelativePath = relative(repoRoot, resolvedTargetPath);
  if (targetRelativePath.startsWith('..')) {
    return false;
  }

  const [kind, name, srcSegment] = targetRelativePath.split(sep);
  if (kind !== 'packages' || srcSegment !== 'src') {
    return false;
  }

  return importerWorkspace.kind !== 'packages' || importerWorkspace.name !== name;
}

function findCrossPackageSrcImportOffenders(): string[] {
  const offenders: string[] = [];
  const runtimeFiles = workspaceRoots.flatMap((root) => collectWorkspaceRuntimeFiles(root));

  for (const runtimeFile of runtimeFiles) {
    const importerRelativePath = relative(repoRoot, runtimeFile).split(sep).join('/');

    for (const specifier of getImportSpecifiers(runtimeFile)) {
      const resolvedTargetPath = resolveImportTarget(runtimeFile, specifier);
      if (!resolvedTargetPath || !isCrossPackageSrcImport(runtimeFile, resolvedTargetPath)) {
        continue;
      }

      const resolvedRelativePath = relative(repoRoot, resolvedTargetPath).split(sep).join('/');
      offenders.push(`${importerRelativePath} -> ${specifier} (${resolvedRelativePath})`);
    }
  }

  return offenders.sort();
}

describe('source import architecture', () => {
  it('keeps app and package runtime code out of sibling package src internals', () => {
    expect(findCrossPackageSrcImportOffenders()).toEqual([]);
  });
});
