export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(message = 'Payload too large') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export function isWebhookContentLengthTooLarge(
  request: Request,
  maxBytes = MAX_WEBHOOK_BODY_BYTES
): boolean {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

export async function readWebhookTextBody(
  request: Request,
  maxBytes = MAX_WEBHOOK_BODY_BYTES
): Promise<string> {
  const body = await request.text();
  const size = new TextEncoder().encode(body).byteLength;
  if (size > maxBytes) {
    throw new PayloadTooLargeError();
  }
  return body;
}
