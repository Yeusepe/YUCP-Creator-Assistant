import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ScriptScope = 'root' | 'web';
type ScriptCatalog = Record<ScriptScope, Record<string, string>>;

interface EntrypointAnalysis {
  requiresLicensedIcons: boolean;
  violations: string[];
}

interface TraversalState {
  scripts: Set<string>;
  sources: Set<string>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const workflow = await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text();
const gitignore = await Bun.file(new URL('../../.gitignore', import.meta.url)).text();
const readme = await Bun.file(new URL('../../README.md', import.meta.url)).text();
const webPackageJson = (await Bun.file(
  new URL('../../apps/web/package.json', import.meta.url)
).json()) as { scripts?: Record<string, string> };
const rootPackageJson = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
  scripts?: Record<string, string>;
};
const webEntrypointRunner = await Bun.file(
  new URL('../run-web-with-icons.ts', import.meta.url)
).text();
const githubExpressionPrefix = '$' + '{{';
const trustedRepositoryOnlyCondition =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
const sourceExtensionPattern = /\.(?:[cm]?[jt]sx?)$/;

function mergeAnalyses(analyses: EntrypointAnalysis[]): EntrypointAnalysis {
  return {
    requiresLicensedIcons: analyses.some((analysis) => analysis.requiresLicensedIcons),
    violations: analyses.flatMap((analysis) => analysis.violations),
  };
}

function readReferencedSource(sourcePath: string): string | undefined {
  const absolutePath = resolve(repoRoot, sourcePath);
  if (!sourceExtensionPattern.test(extname(absolutePath))) {
    return undefined;
  }

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

function analyzeSourceEntrypoint(
  sourcePath: string,
  scripts: ScriptCatalog,
  chain: string[],
  state: TraversalState
): EntrypointAnalysis {
  const normalizedPath = sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (state.sources.has(normalizedPath)) {
    return { requiresLicensedIcons: false, violations: [] };
  }
  state.sources.add(normalizedPath);

  const source = readReferencedSource(normalizedPath);
  if (!source) {
    return { requiresLicensedIcons: false, violations: [] };
  }

  const analyses: EntrypointAnalysis[] = [];
  const webScriptArrayPattern =
    /\[\s*['"]bun['"]\s*,\s*['"]run['"]\s*,\s*['"]--filter['"]\s*,\s*['"]@yucp\/web['"]\s*,\s*['"]([\w:-]+)['"]/g;
  for (const match of source.matchAll(webScriptArrayPattern)) {
    analyses.push(
      analyzeScriptEntrypoint('web', match[1], scripts, [...chain, normalizedPath], state)
    );
  }

  const embeddedRootScriptPattern = /\bbun run ([\w:-]+)\b/g;
  for (const match of source.matchAll(embeddedRootScriptPattern)) {
    analyses.push(
      analyzeScriptEntrypoint('root', match[1], scripts, [...chain, normalizedPath], state)
    );
  }

  const sourceDirectory = dirname(normalizedPath);
  const relativeImportPattern = /\bfrom\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(relativeImportPattern)) {
    const importedPath = resolve(sourceDirectory, match[1]).replaceAll('\\', '/');
    const importedSourcePaths = extname(importedPath)
      ? [importedPath]
      : ['.ts', '.tsx', '.js', '.mjs', '.cjs'].map((extension) => `${importedPath}${extension}`);
    const importedSourcePath = importedSourcePaths.find((candidate) => existsSync(candidate));
    if (importedSourcePath) {
      analyses.push(
        analyzeSourceEntrypoint(importedSourcePath, scripts, [...chain, normalizedPath], state)
      );
    }
  }

  const directlyLoadsWeb =
    /(?:cwdRelativeToRepoRoot:\s*['"]apps\/web['"]|from\s+['"][^'"]*apps\/web\/src\/|@\/icons\/generated)/.test(
      source
    ) && /\b(?:vite|vitest|playwright|bun\s+test)\b/.test(source);
  if (directlyLoadsWeb) {
    analyses.push({
      requiresLicensedIcons: true,
      violations: [`${[...chain, normalizedPath].join(' -> ')} loads apps/web without icons:run`],
    });
  }

  return mergeAnalyses(analyses);
}

function analyzeCommandEntrypoint(
  scope: ScriptScope,
  command: string,
  scripts: ScriptCatalog,
  chain: string[],
  state: TraversalState = { scripts: new Set(), sources: new Set() }
): EntrypointAnalysis {
  if (/\bbun run(?: --filter (?:['"]?@yucp\/web['"]?))? icons:run --/.test(command)) {
    return { requiresLicensedIcons: true, violations: [] };
  }

  const analyses: EntrypointAnalysis[] = [];
  const filteredScriptPattern = /\bbun run --filter (?:'([^']+)'|"([^"]+)"|(\S+)) ([\w:-]+)\b/g;
  for (const match of command.matchAll(filteredScriptPattern)) {
    const filter = match[1] ?? match[2] ?? match[3];
    if (filter === '@yucp/web' || filter === '*') {
      analyses.push(analyzeScriptEntrypoint('web', match[4], scripts, chain, state));
    }
  }

  const rootCwdScriptPattern = /\bbun run --cwd \.\.\/\.\.\/ ([\w:-]+)\b/g;
  for (const match of command.matchAll(rootCwdScriptPattern)) {
    analyses.push(analyzeScriptEntrypoint('root', match[1], scripts, chain, state));
  }

  const unfilteredScriptPattern = /\bbun run ([\w:-]+)\b/g;
  const nestedScope: ScriptScope = command.includes('cd ../..') ? 'root' : scope;
  for (const match of command.matchAll(unfilteredScriptPattern)) {
    analyses.push(analyzeScriptEntrypoint(nestedScope, match[1], scripts, chain, state));
  }

  const sourceEntrypointPattern =
    /\b(?:bun run|tsx) (?:--env-file=\S+ )?(\.?\.?[\\/\w.-]+\.(?:[cm]?[jt]sx?))\b/g;
  for (const match of command.matchAll(sourceEntrypointPattern)) {
    analyses.push(analyzeSourceEntrypoint(match[1], scripts, chain, state));
  }

  const commandRunsInWeb =
    scope === 'web' ||
    /(?:cd|--cwd|working-directory:)\s+apps\/web\b/.test(command) ||
    /\b(?:vite|vitest|playwright\s+test|bun\s+test)\b[^\n]*apps\/web\b/.test(command);
  if (
    commandRunsInWeb &&
    /\b(?:vite|vitest|playwright\s+test|wrangler\s+dev|bun\s+test)\b/.test(command)
  ) {
    analyses.push({
      requiresLicensedIcons: true,
      violations: [`${chain.join(' -> ')} invokes ${JSON.stringify(command)} without icons:run`],
    });
  }

  return mergeAnalyses(analyses);
}

function analyzeScriptEntrypoint(
  scope: ScriptScope,
  scriptName: string,
  scripts: ScriptCatalog,
  chain: string[] = [],
  state: TraversalState = { scripts: new Set(), sources: new Set() }
): EntrypointAnalysis {
  const scriptId = `${scope}:${scriptName}`;
  if (state.scripts.has(scriptId)) {
    return { requiresLicensedIcons: false, violations: [] };
  }
  const command = scripts[scope][scriptName];
  if (!command) {
    return { requiresLicensedIcons: false, violations: [] };
  }
  state.scripts.add(scriptId);
  return analyzeCommandEntrypoint(scope, command, scripts, [...chain, scriptId], state);
}

function getWorkflowJobs(workflowSource: string): Array<{ name: string; source: string }> {
  const lines = workflowSource.split(/\r?\n/);
  const jobsStart = lines.indexOf('jobs:');
  if (jobsStart < 0) {
    return [];
  }

  const jobs: Array<{ name: string; source: string }> = [];
  let currentJobName: string | undefined;
  let currentJobLines: string[] = [];
  for (const line of lines.slice(jobsStart + 1)) {
    const jobMatch = line.match(/^ {2}([a-z][\w-]*):$/);
    if (jobMatch) {
      if (currentJobName) {
        jobs.push({ name: currentJobName, source: currentJobLines.join('\n') });
      }
      currentJobName = jobMatch[1];
      currentJobLines = [line];
    } else if (currentJobName) {
      currentJobLines.push(line);
    }
  }
  if (currentJobName) {
    jobs.push({ name: currentJobName, source: currentJobLines.join('\n') });
  }
  return jobs;
}

function getJob(jobName: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  if (start < 0) {
    throw new Error(`Missing CI job: ${jobName}`);
  }
  const nextJobOffset = lines.slice(start + 1).findIndex((line) => /^ {2}[a-z][\w-]*:$/.test(line));
  const end = nextJobOffset < 0 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end).join('\n');
}

describe('licensed icon CI regeneration', () => {
  test('disables persisted credentials for every CI checkout', () => {
    const checkoutSteps = workflow
      .split(/(?=^\s+- uses: actions\/checkout@)/m)
      .filter((block) => block.match(/^\s+- uses: actions\/checkout@/));

    expect(checkoutSteps.length).toBeGreaterThan(0);
    for (const checkoutStep of checkoutSteps) {
      expect(checkoutStep.slice(0, 200)).toContain('persist-credentials: false');
    }
  });

  test('keeps every credential-free gate running for fork pull requests', () => {
    for (const jobName of ['lint', 'typecheck', 'test', 'convex-real', 'e2e-flows']) {
      const job = getJob(jobName);
      expect(job).not.toContain(`\n    if: ${trustedRepositoryOnlyCondition}`);
      expect(job).not.toContain('icons:sync');
      expect(job).not.toContain('ASSETS_S3_');
      expect(job).not.toContain('VITE_ASSETS_S3');
    }
  });

  test('visibly skips licensed-icon jobs for fork pull requests', () => {
    for (const jobName of ['web-build', 'external-integrations', 'web-tests']) {
      const job = getJob(jobName);
      expect(job).toContain(`\n    if: ${trustedRepositoryOnlyCondition}`);
      expect(job).not.toContain('LICENSED_ICON_SECRETS_AVAILABLE');
      expect(job).not.toContain(
        'Licensed icon gate skipped because build credentials are unavailable'
      );
      for (const variable of [
        'ASSETS_S3_BUCKET',
        'ASSETS_S3_ENDPOINT',
        'ASSETS_S3_REGION',
        'ASSETS_S3_READONLY_ACCESS_KEY_ID',
        'ASSETS_S3_READONLY_SECRET_ACCESS_KEY',
      ]) {
        expect(job).toContain(`${variable}: ${githubExpressionPrefix} secrets.${variable} }}`);
      }
    }
  });

  test('supplies read-only icon credentials to the shared web build entrypoint', () => {
    const buildStep = getJob('web-build').split('- name: Build web app')[1] ?? '';

    expect(buildStep).toContain(
      `ASSETS_S3_BUCKET: ${githubExpressionPrefix} secrets.ASSETS_S3_BUCKET }}`
    );
    expect(buildStep).toContain(
      `ASSETS_S3_READONLY_ACCESS_KEY_ID: ${githubExpressionPrefix} secrets.ASSETS_S3_READONLY_ACCESS_KEY_ID }}`
    );
    expect(buildStep).toContain(
      `ASSETS_S3_READONLY_SECRET_ACCESS_KEY: ${githubExpressionPrefix} secrets.ASSETS_S3_READONLY_SECRET_ACCESS_KEY }}`
    );
    expect(buildStep).toContain("run: bun run --filter '@yucp/web' build");
    expect(buildStep).not.toContain('VITE_ASSETS_S3');
  });

  test('never exposes read-write asset credentials to icon sync jobs', () => {
    expect(workflow).not.toContain(`${githubExpressionPrefix} secrets.ASSETS_S3_ACCESS_KEY_ID }}`);
    expect(workflow).not.toContain(
      `${githubExpressionPrefix} secrets.ASSETS_S3_SECRET_ACCESS_KEY }}`
    );
  });

  test('ignores both the generated module and interrupted atomic-write temp files', () => {
    expect(gitignore).toContain('/apps/web/src/icons/generated.tsx*');
  });

  test('generates icons before the local Worker deploy-shape preview', () => {
    expect(webPackageJson.scripts?.['worker:preview']).toBe('bun run icons:run -- worker:preview');
  });

  test('generates icons before both direct web test entrypoints', () => {
    expect(webPackageJson.scripts?.test).toBe('bun run icons:run -- test');
    expect(webPackageJson.scripts?.['test:ci']).toBe('bun run icons:run -- test');
    expect(webEntrypointRunner).toContain(
      "commands: [[BUN_EXECUTABLE, 'x', 'vitest', 'run', '--config', 'vitest.config.ts']]"
    );
  });

  test('generates icons before the external integration gate loads web consumers', () => {
    expect(rootPackageJson.scripts?.['test:external-integrations']).toBe(
      "bun run --filter '@yucp/web' icons:run -- external-integrations"
    );
    expect(webEntrypointRunner).toContain("'external-integrations': {");
    expect(webEntrypointRunner).toContain(
      "commands: [[BUN_EXECUTABLE, 'run', 'ops/test-external-integrations.ts']]"
    );
  });

  test('enumerates package and workflow entrypoints and rejects every unwired web load', () => {
    const scripts: ScriptCatalog = {
      root: rootPackageJson.scripts ?? {},
      web: webPackageJson.scripts ?? {},
    };
    const packageViolations = (Object.keys(scripts) as ScriptScope[]).flatMap((scope) =>
      Object.keys(scripts[scope]).flatMap(
        (scriptName) => analyzeScriptEntrypoint(scope, scriptName, scripts).violations
      )
    );
    expect(packageViolations).toEqual([]);

    const workflowDirectory = resolve(repoRoot, '.github/workflows');
    const licensedWorkflowJobs: string[] = [];
    for (const workflowEntry of readdirSync(workflowDirectory, { withFileTypes: true })) {
      if (!workflowEntry.isFile() || !/\.ya?ml$/.test(workflowEntry.name)) {
        continue;
      }
      const workflowSource = readFileSync(resolve(workflowDirectory, workflowEntry.name), 'utf8');
      for (const job of getWorkflowJobs(workflowSource)) {
        const scope: ScriptScope = /working-directory:\s*apps\/web/.test(job.source)
          ? 'web'
          : 'root';
        const analysis = analyzeCommandEntrypoint(scope, job.source, scripts, [
          `${workflowEntry.name}:${job.name}`,
        ]);
        expect(analysis.violations).toEqual([]);
        if (!analysis.requiresLicensedIcons) {
          continue;
        }

        licensedWorkflowJobs.push(`${workflowEntry.name}:${job.name}`);
        expect(job.source).toContain(`if: ${trustedRepositoryOnlyCondition}`);
        for (const variable of [
          'ASSETS_S3_BUCKET',
          'ASSETS_S3_ENDPOINT',
          'ASSETS_S3_REGION',
          'ASSETS_S3_READONLY_ACCESS_KEY_ID',
          'ASSETS_S3_READONLY_SECRET_ACCESS_KEY',
        ]) {
          expect(job.source).toContain(
            `${variable}: ${githubExpressionPrefix} secrets.${variable} }}`
          );
        }
      }
    }
    expect(licensedWorkflowJobs.length).toBeGreaterThan(0);
  });

  test('documents every licensed-asset input required by Cloudflare Worker Builds', () => {
    for (const variable of [
      'ASSETS_S3_BUCKET',
      'ASSETS_S3_ENDPOINT',
      'ASSETS_S3_REGION',
      'ASSETS_S3_READONLY_ACCESS_KEY_ID',
      'ASSETS_S3_READONLY_SECRET_ACCESS_KEY',
    ]) {
      expect(readme).toContain(variable);
    }
    expect(readme).toContain(
      'https://developers.cloudflare.com/workers/ci-cd/builds/configuration/'
    );
  });

  test('ships only a type contract for clean-worktree icon type checking', async () => {
    const declaration = Bun.file(
      new URL('../../apps/web/src/icons/licensedIconModule.d.ts', import.meta.url)
    );
    expect(await declaration.exists()).toBe(true);
    expect(declaration.name).not.toMatch(/[/\\]generated[^/\\]*$/);
    expect(await declaration.text()).toContain("declare module '@/icons/generated'");
    expect(await declaration.text()).toContain('generatedIcons: Record<IconName, GeneratedIcon>');
  });
});
