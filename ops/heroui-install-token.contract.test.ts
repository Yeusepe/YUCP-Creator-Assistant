import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(process.cwd(), '.github', 'workflows');
const INSTALL_COMMAND = 'run: bun install --frozen-lockfile';
const HEROUI_ACTIONS_SECRET = 'secrets.HEROUI_AUTH_TOKEN';
const TRUSTED_HEROUI_ACTIONS_SECRET = `HEROUI_AUTH_TOKEN: \${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && secrets.HEROUI_AUTH_TOKEN || '' }}`;

function readWorkflowSources(): Array<{ path: string; source: string }> {
  return readdirSync(WORKFLOWS_DIR)
    .filter((fileName) => fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
    .map((fileName) => {
      const path = join(WORKFLOWS_DIR, fileName);
      return {
        path,
        source: readFileSync(path, 'utf8'),
      };
    });
}

function collectInstallStepBlocks(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== INSTALL_COMMAND) {
      continue;
    }

    let start = index;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      if (lines[cursor]?.trim().startsWith('- name:')) {
        start = cursor;
        break;
      }
    }

    const stepIndent = lines[start]?.match(/^(\s*)/)?.[1].length ?? 0;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent === stepIndent && line.trim().startsWith('- ')) {
        end = cursor;
        break;
      }
    }

    blocks.push(lines.slice(start, end).join('\n'));
  }

  return blocks;
}

describe('HeroUI Pro install token plumbing', () => {
  test('passes the GitHub Actions secret to every frozen Bun install step', () => {
    const installSteps = readWorkflowSources().flatMap(({ path, source }) =>
      collectInstallStepBlocks(source).map((block) => ({ path, block }))
    );

    expect(installSteps.length).toBeGreaterThan(0);

    for (const { path, block } of installSteps) {
      expect(block, `${path} install step must define HEROUI_AUTH_TOKEN`).toContain(
        'HEROUI_AUTH_TOKEN:'
      );
      expect(block, `${path} install step must use the HeroUI Actions secret`).toContain(
        HEROUI_ACTIONS_SECRET
      );
    }
  });

  test('withholds the storage install token from fork pull requests', () => {
    const source = readFileSync(join(WORKFLOWS_DIR, 'storage-e2e.yml'), 'utf8');
    const installSteps = collectInstallStepBlocks(source);

    expect(installSteps).toHaveLength(1);
    expect(installSteps[0]).toContain(TRUSTED_HEROUI_ACTIONS_SECRET);
  });

  test('uses a Docker build secret for the web preview image install', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('# syntax=docker/dockerfile:1.7');
    expect(dockerfile).toContain('id=HEROUI_AUTH_TOKEN,required=true');
    expect(dockerfile).toContain('cat /run/secrets/HEROUI_AUTH_TOKEN');
    expect(dockerfile).toContain('bun install --frozen-lockfile');
  });

  test('runs the web preview image as the Bun base image non-root user with a healthcheck', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8');

    expect(dockerfile).not.toMatch(/\b(?:addgroup|adduser)\b/);
    expect(dockerfile).toContain('USER bun');
    expect(dockerfile).toMatch(/^HEALTHCHECK\b/m);
    expect(dockerfile).toContain(`http://127.0.0.1:\${PORT:-3000}`);
  });

  test('declares HeroUI Pro static icon imports for clean Workers builds', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps', 'web', 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
    };

    // Upstream: https://github.com/heroui-inc/heroui/issues/6468
    expect(packageJson.dependencies?.['@gravity-ui/icons']).toBeDefined();
  });
});
