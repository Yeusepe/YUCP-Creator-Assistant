#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(repoRoot, 'ops', 'boundary-mock-ratchet.baseline.txt');
const apiConvexLibPath = resolve(repoRoot, 'apps', 'api', 'src', 'lib', 'convex');
const moduleResolutionSuffixes = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const apiConvexBoundaryPaths = new Set([
  ...moduleResolutionSuffixes.map((suffix) => `${apiConvexLibPath}${suffix}`),
  ...moduleResolutionSuffixes.map((suffix) => resolve(apiConvexLibPath, `index${suffix}`)),
]);
const scanRoots = ['apps', 'packages', 'ops', 'convex'];
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const baseline = Number(readFileSync(baselinePath, 'utf8').trim());
if (!Number.isInteger(baseline) || baseline < 0) {
  console.error(`Invalid boundary mock baseline in ${relative(repoRoot, baselinePath)}`);
  process.exit(1);
}

function isTestFile(path) {
  return /\.(?:test|spec|realtest)\.[cm]?[tj]sx?$/.test(path);
}

function collectTestFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && isTestFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function resolvesToApiConvexBoundary(filePath, moduleSpecifier) {
  if (moduleSpecifier.includes('apps/api/src/lib/convex')) {
    return true;
  }

  if (!moduleSpecifier.startsWith('.')) {
    return false;
  }

  return apiConvexBoundaryPaths.has(resolve(dirname(filePath), moduleSpecifier));
}

function mocksConvexBoundary(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const mockModulePattern = /\b(?:mock\.module|vi\.mock|jest\.mock)\(\s*(['"`])([^'"`]+)\1/g;

  for (const match of source.matchAll(mockModulePattern)) {
    const moduleSpecifier = match[2];
    if (
      moduleSpecifier.includes('convex/_generated/api') ||
      resolvesToApiConvexBoundary(filePath, moduleSpecifier)
    ) {
      return true;
    }
  }

  return false;
}

const testFiles = scanRoots
  .map((root) => resolve(repoRoot, root))
  .filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(collectTestFiles);

const boundaryMockFiles = testFiles
  .filter(mocksConvexBoundary)
  .map((filePath) => relative(repoRoot, filePath).replaceAll('\\', '/'))
  .sort((left, right) => left.localeCompare(right));
const shouldListFiles = process.argv.includes('--list');

console.log(
  `Convex boundary mock ratchet: ${boundaryMockFiles.length} test files, baseline ${baseline}.`
);

if (boundaryMockFiles.length > baseline) {
  console.error(
    `Convex boundary mock ratchet exceeded: ${boundaryMockFiles.length} test files is above baseline ${baseline}.`
  );
  if (shouldListFiles) {
    for (const filePath of boundaryMockFiles) {
      console.error(`- ${filePath}`);
    }
  } else {
    console.error('Run with --list to print the matching files.');
  }
  process.exit(1);
}
