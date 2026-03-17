import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison using Node's native timingSafeEqual.
 *
 * Pads both buffers to the same length before comparison so that the
 * comparison always takes the same amount of time regardless of content.
 * The length check is performed after, using the already-constant-time
 * result, to prevent early-exit length leaks.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const maxLen = Math.max(ab.length, bb.length);
  // Pad both buffers to the same length to avoid short-circuit on length mismatch
  const ap = Buffer.concat([ab, Buffer.alloc(maxLen - ab.length)]);
  const bp = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)]);
  // timingSafeEqual is constant-time; the length check is done after to avoid leaking
  return timingSafeEqual(ap, bp) && ab.length === bb.length;
}
