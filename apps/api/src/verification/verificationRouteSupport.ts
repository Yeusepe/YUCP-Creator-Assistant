import type { VerificationConfig } from './verificationConfig';

const VRCHAT_VERIFY_ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const VRCHAT_VERIFY_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const VRCHAT_VERIFY_RATE_LIMIT_MAX = 10;

export const VERIFY_PANEL_PREFIX = 'verify_panel:';
export const VERIFY_PANEL_TTL_MS = 15 * 60 * 1000;
export const INTERACTION_TOKEN_PURPOSE = 'verify-panel-interaction-token';

export interface StoredVerifyPanel {
  applicationId: string;
  discordUserId: string;
  guildId: string;
  /** AES-GCM encrypted interaction token (see INTERACTION_TOKEN_PURPOSE). */
  encryptedInteractionToken: string;
  messageId: string;
  authUserId: string;
}

function getRequestIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export function withNoStore(headers?: unknown): Headers {
  const result = new Headers();
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result.set(key, value);
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result.set(key, value);
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result.set(key, value);
      }
    }
  }
  result.set('Cache-Control', 'no-store');
  return result;
}

export function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = withNoStore(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function withSetCookies(headers: Headers, cookies: string[]): Headers {
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return headers;
}

export function isVrchatRateLimited(token: string, request: Request): boolean {
  const now = Date.now();
  for (const [candidateKey, candidate] of VRCHAT_VERIFY_ATTEMPTS.entries()) {
    if (now >= candidate.resetAt) {
      VRCHAT_VERIFY_ATTEMPTS.delete(candidateKey);
    }
  }

  const key = `${token}:${getRequestIp(request)}`;
  const existing = VRCHAT_VERIFY_ATTEMPTS.get(key);
  if (!existing || now >= existing.resetAt) {
    VRCHAT_VERIFY_ATTEMPTS.set(key, {
      count: 1,
      resetAt: now + VRCHAT_VERIFY_RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  existing.count += 1;
  VRCHAT_VERIFY_ATTEMPTS.set(key, existing);
  return existing.count > VRCHAT_VERIFY_RATE_LIMIT_MAX;
}

function getRequestOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin) {
    return origin;
  }

  const referer = request.headers.get('referer');
  if (!referer) {
    return null;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(request: Request, config: VerificationConfig): boolean {
  const requestOrigin = getRequestOrigin(request);
  if (!requestOrigin) {
    return false;
  }

  try {
    const allowedOrigins = new Set([
      new URL(config.baseUrl).origin,
      new URL(config.frontendUrl).origin,
    ]);
    return allowedOrigins.has(requestOrigin);
  } catch {
    return false;
  }
}

export function isAllowedVrchatOrigin(request: Request, config: VerificationConfig): boolean {
  return isAllowedOrigin(request, config);
}

export function isAllowedVerifyPanelOrigin(request: Request, config: VerificationConfig): boolean {
  return isAllowedOrigin(request, config);
}

export function buildVerifyPanelRefreshReply() {
  return {
    components: [
      {
        type: 17,
        accent_color: 0x57f287,
        components: [
          {
            type: 10,
            content: '## You are verified',
          },
          {
            type: 14,
            divider: true,
            spacing: 1,
          },
          {
            type: 10,
            content:
              'Your account is connected. Roles will update shortly. If you want the full status panel again, use the button below.',
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: 'verify_start',
                label: 'Refresh Status',
                style: 1,
              },
            ],
          },
        ],
      },
    ],
    flags: 32768,
  };
}
