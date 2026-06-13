type BoundedBodySource = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
};

export function readContentLength(headers: Headers): number | null {
  const parsed = Number.parseInt(headers.get('content-length') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function createResponseBodyLimitError(maxBytes: number): Error {
  return new Error(`Response body exceeds the ${maxBytes} byte limit.`);
}

export async function readBoundedArrayBuffer(
  bodySource: BoundedBodySource,
  maxBytes: number,
  createLimitError: (maxBytes: number) => Error = createResponseBodyLimitError
): Promise<ArrayBuffer> {
  const contentLength = readContentLength(bodySource.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    throw createLimitError(maxBytes);
  }

  if (!bodySource.body) {
    const bytes = await bodySource.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw createLimitError(maxBytes);
    }
    return bytes;
  }

  const reader = bodySource.body.getReader();
  let bytes = new Uint8Array(contentLength ?? 0);
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const nextByteLength = byteLength + chunk.value.byteLength;
      if (nextByteLength > maxBytes) {
        await reader.cancel('body size limit exceeded').catch(() => undefined);
        throw createLimitError(maxBytes);
      }
      if (nextByteLength > bytes.byteLength) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextByteLength, bytes.byteLength * 2, 64 * 1024)
        );
        const nextBytes = new Uint8Array(nextCapacity);
        nextBytes.set(bytes.subarray(0, byteLength));
        bytes = nextBytes;
      }
      bytes.set(chunk.value, byteLength);
      byteLength = nextByteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === bytes.byteLength) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(0, byteLength);
}
