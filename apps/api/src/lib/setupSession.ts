/**
 * Setup Session Management
 *
 * Creates and resolves HMAC-signed opaque tokens for the setup flow.
 * Tokens map to server-side state (tenantId, guildId, discordUserId).
 * No internal IDs are exposed in URLs.
 */

import { createLogger } from '@yucp/shared';
import { getStateStore } from './stateStore';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const SETUP_SESSION_PREFIX = 'setup_session:';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SetupSessionData {
    tenantId: string;
    guildId: string;
    discordUserId: string;
    createdAt: number;
    expiresAt: number;
}

/**
 * Generate a cryptographically random URL-safe token.
 */
function generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // base64url encode (URL-safe, no padding)
    const base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a token with HMAC-SHA256 to prevent forgery.
 */
async function hmacSign(token: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
    const sigBytes = new Uint8Array(signature);
    const base64 = btoa(String.fromCharCode(...sigBytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create a setup session token.
 * Returns the opaque token string to use in `?s=TOKEN`.
 */
export async function createSetupSession(
    tenantId: string,
    guildId: string,
    discordUserId: string,
    secret: string,
): Promise<string> {
    const token = generateToken();
    const sig = await hmacSign(token, secret);
    const signedToken = `${token}.${sig}`;

    const now = Date.now();
    const data: SetupSessionData = {
        tenantId,
        guildId,
        discordUserId,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
    };

    const store = getStateStore();
    await store.set(
        `${SETUP_SESSION_PREFIX}${signedToken}`,
        JSON.stringify(data),
        SESSION_TTL_MS,
    );

    logger.info('Setup session created', {
        tokenPrefix: signedToken.slice(0, 8) + '...',
        tenantId,
        guildId,
    });

    return signedToken;
}

/**
 * Resolve a setup session token.
 * Returns the session data if valid and not expired, null otherwise.
 * Renews the TTL on each successful resolve.
 */
export async function resolveSetupSession(
    signedToken: string,
    secret: string,
): Promise<SetupSessionData | null> {
    if (!signedToken || !signedToken.includes('.')) {
        return null;
    }

    const [token, sig] = signedToken.split('.', 2);
    if (!token || !sig) return null;

    // Verify HMAC signature
    const expectedSig = await hmacSign(token, secret);
    if (sig !== expectedSig) {
        logger.warn('Setup session HMAC verification failed', {
            tokenPrefix: signedToken.slice(0, 8) + '...',
        });
        return null;
    }

    const store = getStateStore();
    const raw = await store.get(`${SETUP_SESSION_PREFIX}${signedToken}`);
    if (!raw) {
        return null;
    }

    const data = JSON.parse(raw) as SetupSessionData;

    // Check expiration
    if (Date.now() > data.expiresAt) {
        await store.delete(`${SETUP_SESSION_PREFIX}${signedToken}`);
        return null;
    }

    // Renew TTL
    data.expiresAt = Date.now() + SESSION_TTL_MS;
    await store.set(
        `${SETUP_SESSION_PREFIX}${signedToken}`,
        JSON.stringify(data),
        SESSION_TTL_MS,
    );

    return data;
}

/**
 * Delete a setup session.
 */
export async function deleteSetupSession(signedToken: string): Promise<void> {
    const store = getStateStore();
    await store.delete(`${SETUP_SESSION_PREFIX}${signedToken}`);
}
