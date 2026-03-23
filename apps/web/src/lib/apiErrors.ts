import { ApiError } from '@/api/client';

function readErrorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const value = body as Record<string, unknown>;
  if (typeof value.error === 'string' && value.error.trim()) {
    return value.error.trim();
  }
  if (typeof value.message === 'string' && value.message.trim()) {
    return value.message.trim();
  }

  return null;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const bodyMessage = readErrorMessageFromBody(error.body);
    if (bodyMessage) {
      return bodyMessage;
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}
