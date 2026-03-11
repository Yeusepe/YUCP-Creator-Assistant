const INTERNAL_ERROR_PATTERNS = [
  /request id:/i,
  /argumentvalidationerror/i,
  /server error/i,
  /validator:/i,
  /stack:/i,
  /convex/i,
  /http \d{3}/i,
  /unauthorized: invalid or missing api secret/i,
  /missingaccesstoken/i,
  /internal server error/i,
];

export function sanitizePublicErrorMessage(
  rawMessage: string | null | undefined,
  fallback: string
): string {
  const trimmed = rawMessage?.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 180) return fallback;
  if (INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return fallback;
  }
  return trimmed;
}
