export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<string> {
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyError('Request body too large', 413);
  }
  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        throw new RequestBodyError('Request body too large', 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bodyBytes);
}

export async function readJsonObjectBodyWithLimit(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const text = await readRequestTextWithLimit(request, maxBytes);
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError('Invalid JSON body', 400);
  }
  if (!isRecord(parsed)) {
    throw new RequestBodyError('Request body must be a JSON object.', 400);
  }
  return parsed;
}
