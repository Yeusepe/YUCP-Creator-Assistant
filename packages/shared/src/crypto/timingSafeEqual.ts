/**
 * Constant-time string comparison without Node-only APIs.
 *
 * Uses UTF-8 bytes plus XOR accumulation across the padded max length so
 * there is no early return based on content. This keeps the helper usable in
 * browser-like runtimes such as Convex while preserving the same semantics as
 * the previous Node-only implementation.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const maxLen = Math.max(ab.length, bb.length);

  let diff = ab.length ^ bb.length;
  for (let index = 0; index < maxLen; index += 1) {
    diff |= (ab[index] ?? 0) ^ (bb[index] ?? 0);
  }

  return diff === 0;
}
