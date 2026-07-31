import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const SIBLING_ROOT = join(REPO_ROOT, '..', 'ca-coupling', 'transfer-helper');

/**
 * The Go transfer-helper module lives in the ca-coupling repo, checked out beside this one.
 * Everything here that builds, tests or publishes it resolves the path through this function so a
 * different checkout layout is one environment variable, not a search-and-replace.
 */
export function transferHelperRoot(): string {
  return process.env.YUCP_TRANSFER_HELPER_ROOT?.trim() || SIBLING_ROOT;
}
