/**
 * Chunk load error recovery
 *
 * Vite code-splits every route into hashed JS bundles. After a new deployment,
 * the old chunk filenames no longer exist, so lazy route imports 404 and throw
 * an unhandled rejection. This handler detects that error pattern and performs
 * a full page reload, automatically picking up the fresh bundles.
 *
 * A cooldown prevents infinite reload loops: if the page was reloaded less than
 * 30 seconds ago due to this handler, it does NOT reload again.
 */

const RELOAD_COOLDOWN_MS = 30_000;
const STORAGE_KEY = '__chunk_reload_at';

function isChunkLoadError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const msg = reason.message ?? '';
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('Unable to preload CSS for') ||
    reason.name === 'ChunkLoadError'
  );
}

function shouldReload(): boolean {
  try {
    const lastReload = Number(sessionStorage.getItem(STORAGE_KEY) ?? '0');
    return Date.now() - lastReload > RELOAD_COOLDOWN_MS;
  } catch {
    return true;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // sessionStorage not available (e.g. private browsing with storage blocked)
  }
}

function handleRejection(event: PromiseRejectionEvent): void {
  if (!isChunkLoadError(event.reason)) return;
  if (!shouldReload()) return;

  event.preventDefault();
  markReloaded();
  window.location.reload();
}

let installed = false;

/** Install the global chunk-load-error recovery handler once. */
export function installChunkErrorRecovery(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('unhandledrejection', handleRejection);
}
