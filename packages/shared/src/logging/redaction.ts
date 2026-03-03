// Sensitive field redaction utilities
// Redacts tokens, API keys, emails, and other sensitive data

/**
 * Patterns for sensitive data detection
 */
const SENSITIVE_PATTERNS = {
  // Generic token patterns (bearer, JWT, etc.)
  bearerToken: /bearer\s+[a-zA-Z0-9\-_.~+/]+=*/gi,
  // JWT tokens
  jwt: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  // API keys (various formats)
  apiKey: /api[_-]?key["']?\s*[:=]\s*["']?([a-zA-Z0-9\-_]{20,})["']?/gi,
  // Discord tokens
  discordToken: /([MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27})/g,
  // Generic secret patterns
  secret: /secret["']?\s*[:=]\s*["']?([a-zA-Z0-9\-_]{10,})["']?/gi,
  // Password patterns
  password: /password["']?\s*[:=]\s*["']?([^"'\s]{4,})["']?/gi,
  // Authorization headers
  authHeader: /authorization["']?\s*[:=]\s*["']?([a-zA-Z0-9\s\-_.~+/=]+)["']?/gi,
  // License keys (various formats)
  licenseKey: /[A-Z0-9]{4,5}[-_][A-Z0-9]{4,5}[-_][A-Z0-9]{4,5}[-_][A-Z0-9]{4,5}/g,
  // Manual verification codes
  manualCode: /\b\d{4,8}\b/g,
};

/**
 * Field names that should be redacted
 */
const SENSITIVE_FIELD_NAMES = new Set([
  'access_token',
  'refresh_token',
  'token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'private_key',
  'privateKey',
  'authorization',
  'auth',
  'license_key',
  'licenseKey',
  'device_fingerprint',
  'deviceFingerprint',
  'fingerprint',
  'email',
  'raw_email',
  'email_address',
  'emailAddress',
  'discord_token',
  'discordToken',
  'discord_access_token',
  'manual_code',
  'manualCode',
  'verification_code',
  'verificationCode',
]);

/**
 * Redact sensitive data from a string
 */
export function redactString(input: string): string {
  let result = input;

  // Redact Discord tokens
  result = result.replace(SENSITIVE_PATTERNS.discordToken, '[DISCORD_TOKEN_REDACTED]');

  // Redact JWT tokens
  result = result.replace(SENSITIVE_PATTERNS.jwt, '[JWT_REDACTED]');

  // Redact bearer tokens
  result = result.replace(SENSITIVE_PATTERNS.bearerToken, 'bearer [TOKEN_REDACTED]');

  // Redact API keys
  result = result.replace(SENSITIVE_PATTERNS.apiKey, 'api_key: [API_KEY_REDACTED]');

  // Redact secrets
  result = result.replace(SENSITIVE_PATTERNS.secret, 'secret: [SECRET_REDACTED]');

  // Redact passwords
  result = result.replace(SENSITIVE_PATTERNS.password, 'password: [PASSWORD_REDACTED]');

  // Redact authorization headers
  result = result.replace(SENSITIVE_PATTERNS.authHeader, 'authorization: [AUTH_REDACTED]');

  // Redact license keys
  result = result.replace(SENSITIVE_PATTERNS.licenseKey, '[LICENSE_KEY_REDACTED]');

  // Redact manual codes (4-8 digits) - be conservative, only in specific contexts
  // This is applied last and only in context
  result = result.replace(SENSITIVE_PATTERNS.manualCode, (match) => {
    // Only redact if it looks like a code in a suspicious context
    if (match.length >= 4 && match.length <= 8 && /^\d+$/.test(match)) {
      return '[CODE_REDACTED]';
    }
    return match;
  });

  return result;
}

/**
 * Partially redact an email address
 * Example: john.doe@example.com -> j***@example.com
 */
export function redactEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return '[EMAIL_REDACTED]';

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  if (localPart.length <= 2) {
    return `*${domain}`;
  }

  return `${localPart[0]}${'*'.repeat(localPart.length - 2)}${localPart[localPart.length - 1]}${domain}`;
}

/**
 * Check if a field name is sensitive
 */
export function isSensitiveField(fieldName: string): boolean {
  const lowerName = fieldName.toLowerCase().replace(/[-_]/, '');
  return (
    SENSITIVE_FIELD_NAMES.has(lowerName) ||
    SENSITIVE_FIELD_NAMES.has(fieldName) ||
    fieldName.toLowerCase().includes('token') ||
    fieldName.toLowerCase().includes('secret') ||
    fieldName.toLowerCase().includes('key')
  );
}

/**
 * Redact sensitive fields from an object
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  const redacted = { ...obj };

  for (const [key, value] of Object.entries(redacted)) {
    if (isSensitiveField(key)) {
      if (key.toLowerCase().includes('email') && typeof value === 'string') {
        (redacted as Record<string, unknown>)[key] = redactEmail(value);
      } else if (
        key.toLowerCase().includes('fingerprint') ||
        key.toLowerCase().includes('device')
      ) {
        (redacted as Record<string, unknown>)[key] = '[FINGERPRINT_REDACTED]';
      } else if (key.toLowerCase().includes('code') || key.toLowerCase().includes('manual')) {
        (redacted as Record<string, unknown>)[key] = '[CODE_REDACTED]';
      } else if (key.toLowerCase().includes('license')) {
        (redacted as Record<string, unknown>)[key] = '[LICENSE_REDACTED]';
      } else {
        (redacted as Record<string, unknown>)[key] = '[REDACTED]';
      }
    } else if (typeof value === 'string') {
      (redacted as Record<string, unknown>)[key] = redactString(value);
    } else if (typeof value === 'object' && value !== null) {
      (redacted as Record<string, unknown>)[key] = redactObject(value as Record<string, unknown>);
    }
  }

  return redacted;
}

/**
 * Redact any sensitive data from a log message or object
 */
export function redactForLogging<T>(data: T): T {
  if (typeof data === 'string') {
    return redactString(data) as T;
  }

  if (typeof data === 'object' && data !== null) {
    return redactObject(data as Record<string, unknown>) as T;
  }

  return data;
}
