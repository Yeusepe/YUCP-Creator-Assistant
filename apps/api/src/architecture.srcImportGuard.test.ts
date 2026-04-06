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
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
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
    if (!existsSync(candidate)) {
      continue;
    }

    const stats = statSync(candidate);
    if (stats.isFile()) {
      return resolve(candidate);
    }
  }

  return null;
}

function isSrcInternalCrossWorkspaceImport(importerPath: string, importedPath: string): boolean {
  const importerWorkspace = getWorkspace(importerPath);
  const importedWorkspace = getWorkspace(importedPath);
  if (!importerWorkspace || !importedWorkspace) {
    return false;
  }

  if (
    importerWorkspace.kind === importedWorkspace.kind &&
    importerWorkspace.name === importedWorkspace.name
  ) {
    return false;
  }

  const importedRelativePath = relative(repoRoot, importedPath);
  return importedRelativePath.includes(`${sep}src${sep}`);
}

function isCrossWorkspaceProviderKeysSrcImport(
  importerPath: string,
  importedPath: string
): boolean {
  const importerWorkspace = getWorkspace(importerPath);
  const importedWorkspace = getWorkspace(importedPath);
  if (!importerWorkspace || !importedWorkspace) {
    return false;
  }

  if (
    importerWorkspace.kind === importedWorkspace.kind &&
    importerWorkspace.name === importedWorkspace.name
  ) {
    return false;
  }

  return importedPath === resolve(repoRoot, 'packages/shared/src/providerKeys.ts');
}

function isCrossWorkspaceRootProviderDescriptorImport(
  importerPath: string,
  importedPath: string
): boolean {
  const importerWorkspace = getWorkspace(importerPath);
  const importedWorkspace = getWorkspace(importedPath);
  if (!importerWorkspace || !importedWorkspace) {
    return false;
  }

  if (
    importerWorkspace.kind === importedWorkspace.kind &&
    importerWorkspace.name === importedWorkspace.name
  ) {
    return false;
  }

  return importedPath === resolve(repoRoot, 'packages/providers/src/index.ts');
}

function isLegacySharedProviderRegistryImport(importerPath: string, importedPath: string): boolean {
  const importerWorkspace = getWorkspace(importerPath);
  const importedWorkspace = getWorkspace(importedPath);
  if (!importerWorkspace || !importedWorkspace) {
    return false;
  }

  if (
    importerWorkspace.kind === importedWorkspace.kind &&
    importerWorkspace.name === importedWorkspace.name
  ) {
    return false;
  }

  return (
    importedPath === resolve(repoRoot, 'packages/shared/src/providers.ts') ||
    importedPath === resolve(repoRoot, 'packages/shared/src/providers/index.ts')
  );
}

describe('source import architecture', () => {
  const runtimeFiles = workspaceRoots.flatMap((root) => collectWorkspaceRuntimeFiles(root));

  it('keeps app and package runtime code out of sibling package src internals', () => {
    const violations: string[] = [];

    for (const filePath of runtimeFiles) {
      for (const specifier of getImportSpecifiers(filePath)) {
        const target = resolveImportTarget(filePath, specifier);
        if (target && isSrcInternalCrossWorkspaceImport(filePath, target)) {
          violations.push(`${relative(repoRoot, filePath)} -> ${relative(repoRoot, target)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps shared provider key internals out of runtime code', () => {
    const violations: string[] = [];

    for (const filePath of runtimeFiles) {
      for (const specifier of getImportSpecifiers(filePath)) {
        const target = resolveImportTarget(filePath, specifier);
        if (target && isCrossWorkspaceProviderKeysSrcImport(filePath, target)) {
          violations.push(`${relative(repoRoot, filePath)} -> ${relative(repoRoot, target)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps shared-root provider descriptor exports out of runtime code', () => {
    const violations: string[] = [];

    for (const filePath of runtimeFiles) {
      for (const specifier of getImportSpecifiers(filePath)) {
        const target = resolveImportTarget(filePath, specifier);
        if (target && isCrossWorkspaceRootProviderDescriptorImport(filePath, target)) {
          violations.push(`${relative(repoRoot, filePath)} -> ${relative(repoRoot, target)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the legacy shared provider registry out of runtime code', () => {
    const violations: string[] = [];

    for (const filePath of runtimeFiles) {
      for (const specifier of getImportSpecifiers(filePath)) {
        const target = resolveImportTarget(filePath, specifier);
        if (target && isLegacySharedProviderRegistryImport(filePath, target)) {
          violations.push(`${relative(repoRoot, filePath)} -> ${relative(repoRoot, target)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
