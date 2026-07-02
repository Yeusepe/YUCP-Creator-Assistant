import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(process.cwd(), '.github', 'workflows');

describe('GitHub workflow Bun versions', () => {
  it('pins every setup-bun bun-version instead of using mutable tags', () => {
    const mutableBunVersions: string[] = [];

    for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
        continue;
      }

      const workflowPath = join(WORKFLOWS_DIR, entry.name);
      const workflow = readFileSync(workflowPath, 'utf8');
      if (workflow.includes('oven-sh/setup-bun')) {
        const mutableMatch = workflow.match(/bun-version:\s*["']?latest["']?/i);
        if (mutableMatch) {
          mutableBunVersions.push(entry.name);
        }
      }
    }

    expect(mutableBunVersions).toEqual([]);
  });
});
