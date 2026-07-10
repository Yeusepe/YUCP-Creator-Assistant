import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const CONVEX_DIR = join(ROOT_DIR, 'convex');
const REQUIRED_ENV_ERROR = /\b([A-Z][A-Z0-9_]+) is required\b/g;

type FunctionDeclaration = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

type FunctionReference = {
  modulePath: string;
  name: string;
};

type ConvexModule = {
  functions: Map<string, FunctionDeclaration>;
  imports: Map<string, FunctionReference>;
  path: string;
  source: ts.SourceFile;
};

function convexSourceFiles(directory = CONVEX_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '_generated' ? [] : convexSourceFiles(path);
    }
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.d.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.realtest.ts')
    ) {
      return [];
    }
    return [path];
  });
}

function functionDeclaration(node: ts.Node): FunctionDeclaration | null {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node;
  }
  return null;
}

function localFunctions(source: ts.SourceFile): Map<string, FunctionDeclaration> {
  const functions = new Map<string, FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const fn = functionDeclaration(declaration.initializer);
      if (fn) functions.set(declaration.name.text, fn);
    }
  }
  return functions;
}

function exportedFunctionNames(
  source: ts.SourceFile,
  functions: Map<string, FunctionDeclaration>
): Set<string> {
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.canHaveModifiers(statement)) continue;
    const isExported = ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      functions.has(statement.name.text)
    ) {
      exported.add(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && functions.has(declaration.name.text)) {
        exported.add(declaration.name.text);
      }
    }
  }
  return exported;
}

function resolveRelativeModule(fromPath: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) return null;
  const withoutRuntimeExtension = moduleSpecifier.replace(/\.(?:m?js|cjs)$/, '');
  const base = resolve(dirname(fromPath), withoutRuntimeExtension);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildConvexModuleGraph(): Map<string, ConvexModule> {
  const modules = new Map<string, ConvexModule>();
  const exportsByModule = new Map<string, Set<string>>();

  for (const path of convexSourceFiles()) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const functions = localFunctions(source);
    modules.set(path, { functions, imports: new Map(), path, source });
    exportsByModule.set(path, exportedFunctionNames(source, functions));
  }

  for (const module of modules.values()) {
    for (const statement of module.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const importedModulePath = resolveRelativeModule(module.path, statement.moduleSpecifier.text);
      if (!importedModulePath || !modules.has(importedModulePath)) continue;
      const exportedNames = exportsByModule.get(importedModulePath) ?? new Set<string>();
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;

      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!exportedNames.has(importedName)) continue;
        module.imports.set(element.name.text, {
          modulePath: importedModulePath,
          name: importedName,
        });
      }
    }
  }

  return modules;
}

function readProcessEnvName(node: ts.Node): string | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env'
  ) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function requiredEnvNamesInError(node: ts.Node): string[] {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'Error'
  ) {
    return [];
  }
  const argument = node.arguments?.[0];
  if (
    !argument ||
    (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return [];
  }
  return [...argument.text.matchAll(REQUIRED_ENV_ERROR)].map((match) => match[1]);
}

/**
 * Derives the analyzer-time required environment contract from Convex source.
 *
 * Convex evaluates each module during deploy analysis. This scans direct module
 * evaluation plus local/imported function calls and eager callbacks reached from
 * a module-level call (such as Better Auth route registration). Handler bodies
 * are deliberately not traversed, because their environment is runtime-only.
 */
export function requiredConvexDeploymentEnv(): string[] {
  const modules = buildConvexModuleGraph();
  const required = new Set<string>();
  const visitedFunctions = new Set<string>();

  function resolveFunction(
    module: ConvexModule,
    name: string
  ): { module: ConvexModule; fn: FunctionDeclaration } | null {
    const local = module.functions.get(name);
    if (local) return { module, fn: local };

    const imported = module.imports.get(name);
    if (!imported) return null;
    const importedModule = modules.get(imported.modulePath);
    const fn = importedModule?.functions.get(imported.name);
    return importedModule && fn ? { module: importedModule, fn } : null;
  }

  function visitFunction(module: ConvexModule, name: string, fn: FunctionDeclaration): void {
    const key = `${relative(CONVEX_DIR, module.path)}:${name}:${fn.pos}`;
    if (visitedFunctions.has(key)) return;
    visitedFunctions.add(key);
    if (fn.body) visitEvaluatedNode(module, fn.body, false);
  }

  function visitFunctionReference(module: ConvexModule, name: string): void {
    const resolved = resolveFunction(module, name);
    if (resolved) visitFunction(resolved.module, name, resolved.fn);
  }

  function visitEvaluatedNode(
    module: ConvexModule,
    node: ts.Node,
    allowEagerCallbackInvocation: boolean
  ): void {
    if (functionDeclaration(node)) return;

    const envName = readProcessEnvName(node);
    if (envName && allowEagerCallbackInvocation) {
      required.add(envName);
    }

    for (const envNameFromError of requiredEnvNamesInError(node)) {
      required.add(envNameFromError);
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        visitFunctionReference(module, node.expression.text);
      } else if (functionDeclaration(node.expression)) {
        visitFunction(module, 'iife', node.expression);
      }

      if (allowEagerCallbackInvocation) {
        for (const argument of node.arguments) {
          if (ts.isIdentifier(argument)) visitFunctionReference(module, argument.text);
        }
      }
    }

    ts.forEachChild(node, (child) =>
      visitEvaluatedNode(module, child, allowEagerCallbackInvocation)
    );
  }

  for (const module of modules.values()) {
    for (const statement of module.source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer) visitEvaluatedNode(module, declaration.initializer, true);
        }
        continue;
      }
      visitEvaluatedNode(module, statement, true);
    }
  }

  return [...required].sort();
}

async function deploymentEnvIsSet(
  name: string,
  env: Record<string, string | undefined>
): Promise<boolean> {
  const proc = Bun.spawn(['bun', 'x', 'convex', 'env', 'get', name], {
    cwd: ROOT_DIR,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  await new Response(proc.stderr).text();
  return exitCode === 0 && stdout.trim().length > 0;
}

export async function assertRequiredConvexDeploymentEnv(
  env: Record<string, string | undefined> = process.env,
  requiredEnv = requiredConvexDeploymentEnv()
): Promise<void> {
  const missing = (
    await Promise.all(
      requiredEnv.map(async (name) => ((await deploymentEnvIsSet(name, env)) ? null : name))
    )
  ).filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(`Missing required Convex deployment env: ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const requiredEnv = requiredConvexDeploymentEnv();
  await assertRequiredConvexDeploymentEnv(process.env, requiredEnv);
  console.log(`Convex deployment required-env preflight passed (${requiredEnv.length} vars).`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
