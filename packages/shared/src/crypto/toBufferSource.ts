export function toBufferSource(u8: Uint8Array): BufferSource {
  // If the underlying buffer is a SharedArrayBuffer, copy into a new ArrayBuffer
  // because WebCrypto APIs expect ArrayBuffer-backed views (TS DOM lib types).
  const buf = u8.buffer as ArrayBuffer | SharedArrayBuffer | undefined;
  if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) {
    // Create a copy into a fresh ArrayBuffer and return that ArrayBuffer.
    return new Uint8Array(u8).slice().buffer as ArrayBuffer;
  }

  // Narrow to BufferSource for the TypeScript compiler. At runtime this is safe
  // because we only return typed arrays backed by ArrayBuffer (not SharedArrayBuffer).
  return u8 as unknown as BufferSource;
}
