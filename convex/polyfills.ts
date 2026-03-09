/**
 * Polyfills for Convex runtime compatibility.
 * Must be imported before Better Auth or other deps that need these APIs.
 */

// URL.canParse was added in Node 18.17; Convex runtime may not have it
if (typeof URL !== 'undefined' && typeof (URL as { canParse?: unknown }).canParse !== 'function') {
  (URL as { canParse: (url: string, base?: string) => boolean }).canParse = function (
    url: string,
    base?: string
  ) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  };
}
