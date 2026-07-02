import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(process.cwd(), '.github', 'workflows');

function lineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function findStepBlock(lines: string[], usesLineIndex: number): string[] {
  let stepStart = usesLineIndex;
  let stepIndent = lineIndent(lines[usesLineIndex]);
  for (let index = usesLineIndex; index >= 0; index -= 1) {
    if (lines[index].trimStart().startsWith('- ')) {
      stepStart = index;
      stepIndent = lineIndent(lines[index]);
      break;
    }
  }

  let stepEnd = lines.length;
  for (let index = stepStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (lineIndent(line) <= stepIndent && line.trimStart().startsWith('- ')) {
      stepEnd = index;
      break;
    }
  }

  return lines.slice(stepStart, stepEnd);
}

function usesMutableSetupBunVersion(workflow: string): boolean {
  const lines = workflow.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (!/uses:\s*oven-sh\/setup-bun@/i.test(line)) {
      continue;
    }

    const step = findStepBlock(lines, index).join('\n');
    const bunVersion = step.match(/\bbun-version:\s*["']?([^\s"'#]+)["']?/i)?.[1];
    if (!bunVersion || bunVersion.toLowerCase() === 'latest') {
      return true;
    }
  }

  return false;
}

describe('GitHub workflow Bun versions', () => {
  it('treats setup-bun latest versions as mutable', () => {
    const workflow = [
      'name: Example',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5',
      '        with:',
      '          bun-version: latest',
    ].join('\n');

    expect(usesMutableSetupBunVersion(workflow)).toBe(true);
  });

  it('treats omitted setup-bun versions as mutable', () => {
    const workflow = [
      'name: Example',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5',
    ].join('\n');

    expect(usesMutableSetupBunVersion(workflow)).toBe(true);
  });

  it('accepts pinned setup-bun versions', () => {
    const workflow = [
      'name: Example',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5',
      '        with:',
      '          bun-version: "1.3.9"',
    ].join('\n');

    expect(usesMutableSetupBunVersion(workflow)).toBe(false);
  });

  it('pins every setup-bun bun-version instead of using mutable tags', () => {
    const mutableBunVersions: string[] = [];

    for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
        continue;
      }

      const workflowPath = join(WORKFLOWS_DIR, entry.name);
      const workflow = readFileSync(workflowPath, 'utf8');
      if (workflow.includes('oven-sh/setup-bun')) {
        if (usesMutableSetupBunVersion(workflow)) {
          mutableBunVersions.push(entry.name);
        }
      }
    }

    expect(mutableBunVersions).toEqual([]);
  });
});
