/**
 * Polyfills for Convex runtime compatibility.
 * Must be imported before Better Auth or other deps that need these APIs.
 */

import { Buffer } from 'buffer';

export function ensureConvexPolyfills() {
  const globalWithBuffer = globalThis as typeof globalThis & {
    Buffer?: typeof Buffer;
  };

  if (typeof globalWithBuffer.Buffer === 'undefined') {
    globalWithBuffer.Buffer = Buffer;
  }

  // URL.canParse was added in Node 18.17; Convex runtime may not have it
  if (typeof URL !== 'undefined' && typeof (URL as { canParse?: unknown }).canParse !== 'function') {
    (URL as { canParse: (url: string, base?: string) => boolean }).canParse = (
      url: string,
      base?: string
    ) => {
      try {
        new URL(url, base);
        return true;
      } catch {
        return false;
      }
    };
  }
}

ensureConvexPolyfills();
