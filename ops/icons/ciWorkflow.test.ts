import { describe, expect, test } from 'bun:test';

const workflow = await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text();
const githubExpressionPrefix = '$' + '{{';

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
  test('syncs icons before every job that loads web application source', () => {
    for (const jobName of ['typecheck', 'test', 'web-build', 'web-tests']) {
      const job = getJob(jobName);
      expect(job).toContain('- name: Generate licensed icon module');
      expect(job).toContain('run: bun run icons:sync');
      expect(job).toContain(
        `ASSETS_S3_BUCKET: ${githubExpressionPrefix} secrets.ASSETS_S3_BUCKET }}`
      );
      expect(job).toContain(
        `ASSETS_S3_READONLY_ACCESS_KEY_ID: ${githubExpressionPrefix} secrets.ASSETS_S3_READONLY_ACCESS_KEY_ID }}`
      );
      expect(job).toContain(
        `ASSETS_S3_READONLY_SECRET_ACCESS_KEY: ${githubExpressionPrefix} secrets.ASSETS_S3_READONLY_SECRET_ACCESS_KEY }}`
      );
      expect(job).not.toContain('VITE_ASSETS_S3');
    }
  });

  test('never exposes read-write asset credentials to icon sync jobs', () => {
    expect(workflow).not.toContain(`${githubExpressionPrefix} secrets.ASSETS_S3_ACCESS_KEY_ID }}`);
    expect(workflow).not.toContain(
      `${githubExpressionPrefix} secrets.ASSETS_S3_SECRET_ACCESS_KEY }}`
    );
  });
});
