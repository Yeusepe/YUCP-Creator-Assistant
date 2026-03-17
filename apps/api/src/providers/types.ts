/**
 * Provider Plugin Architecture
 *
 * Each provider is a self-contained module that exports a default ProviderPlugin object.
 * The plugin handles credential resolution from Convex, product listing, and (optionally) backfill.
 *
 * Adding a new provider:
 * 1. Create apps/api/src/providers/{name}.ts — implement ProviderPlugin
 * 2. Add import + array entry in apps/api/src/providers/index.ts
 * Route handlers (products.ts, backfill.ts) require zero changes.
 */

import type { Auth } from '../auth';
import type { getConvexClientFromUrl } from '../lib/convex';

/** Infrastructure context passed to all provider plugin methods */
export interface ProviderContext {
  convex: ReturnType<typeof getConvexClientFromUrl>;
  apiSecret: string;
  authUserId: string;
  encryptionSecret: string;
}

/** A single purchase record produced by the backfill pipeline */
export interface BackfillRecord {
  /** Set to '' in fetchPage; injected by the backfill runner */
  authUserId: string;
  provider: string;
  externalOrderId: string;
  externalLineItemId?: string;
  buyerEmailHash: string | undefined;
  /** AES-256-GCM encrypted normalized email (encrypted by the API before sending to Convex) */
  buyerEmailEncrypted?: string | undefined;
  providerUserId?: string;
  providerProductId: string;
  paymentStatus: string;
  lifecycleStatus: 'active' | 'refunded' | 'cancelled' | 'disputed';
  purchasedAt: number;
}

/** A product returned by the products listing endpoint */
export interface ProductRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** Optional backfill capability — providers that don't support backfill omit this */
export interface BackfillPlugin {
  /** Milliseconds to wait between paginated fetches */
  readonly pageDelayMs: number;
  /**
   * Fetch one page of purchase records.
   * @param credential Pre-decrypted provider credential
   * @param productRef Provider-specific product identifier
   * @param cursor Opaque pagination cursor; null = first page
   * @param pageSize Number of items to request per page
   * @param encryptionSecret HKDF root secret for encrypting PII fields at rest
   */
  fetchPage(
    credential: string,
    productRef: string,
    cursor: string | null,
    pageSize: number,
    encryptionSecret: string
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }>;
}

/**
 * Named HKDF domain-separation labels for every credential type a provider encrypts/decrypts.
 * Providers export these as a named `PURPOSES` const so callers import the string from here
 * rather than duplicating magic literals. `credential` is the primary API key / access token.
 */
export interface ProviderPurposes {
  /** The primary credential used in getCredential() / the connect flow */
  readonly credential: string;
  readonly [key: string]: string;
}

/**
 * Shared fields for all provider plugins.
 * The final ProviderPlugin type is a discriminated union that enforces:
 * - If programmaticWebhooks is true, onDisconnect MUST be implemented.
 * - If programmaticWebhooks is false/omitted, onDisconnect is optional.
 */
interface BaseProviderPlugin {
  /** Provider identifier — must match the provider key used in Convex and Gumroad/Jinxxy/etc. */
  readonly id: string;
  /**
   * HKDF purpose strings for every credential type this provider manages.
   * Callers import `PURPOSES` from the provider module and reference e.g. `PURPOSES.credential`.
   */
  readonly purposes: ProviderPurposes;
  /**
   * Whether this provider requires an external API credential.
   * Set to false for providers that only query Convex (e.g. Payhip).
   * When true and getCredential returns null, the handler returns a "not connected" error.
   */
  readonly needsCredential: boolean;
  /**
   * Resolve and decrypt the provider credential from Convex.
   * Returns null if not configured.
   */
  getCredential(ctx: ProviderContext): Promise<string | null>;
  /**
   * List available products for this provider.
   * credential is pre-decrypted (null when needsCredential is false).
   */
  fetchProducts(credential: string | null, ctx: ProviderContext): Promise<ProductRecord[]>;
  /** Optional — undefined means this provider does not support purchase backfill */
  readonly backfill?: BackfillPlugin;
  readonly webhook?: WebhookPlugin;
  readonly connect?: ConnectPlugin;
  readonly verification?: LicenseVerificationPlugin;
  readonly supportsCollab?: boolean;
  readonly productCredentialPurpose?: string;
  /** Display metadata for dynamic UI rendering */
  readonly displayMeta?: ConnectDisplayMeta;
  /**
   * Resolve a human-readable display name for a product given a URL or ID.
   * credential is pre-decrypted (null if not connected).
   */
  resolveProductName?(
    credential: string | null,
    urlOrId: string,
    ctx: ProviderContext
  ): Promise<{ name: string; error?: string }>;
  /**
   * Validate a collaborator API credential (throw on failure).
   * Only providers with supportsCollab=true need to implement this.
   */
  collabValidate?(credential: string): Promise<void>;
  /**
   * HKDF purpose string for encrypting collaborator credentials.
   * Must be set when collabValidate is defined.
   */
  readonly collabCredentialPurpose?: string;
}

/**
 * Provider that programmatically creates webhooks on the external platform
 * during its connect flow (e.g. Gumroad resource_subscriptions, LemonSqueezy webhooks).
 *
 * MUST implement onDisconnect to clean up those webhooks when the connection
 * is removed, preventing stale webhook traffic.
 */
interface ProgrammaticWebhookProvider extends BaseProviderPlugin {
  readonly programmaticWebhooks: true;
  /** REQUIRED: cleanup external webhooks before the connection is soft-deleted. */
  onDisconnect(ctx: DisconnectContext): Promise<void>;
}

/**
 * Provider that either receives webhooks passively (user configures URL manually)
 * or does not use webhooks at all.
 */
interface PassiveWebhookProvider extends BaseProviderPlugin {
  readonly programmaticWebhooks?: false;
  /** Optional cleanup hook. */
  onDisconnect?(ctx: DisconnectContext): Promise<void>;
}

/**
 * The main contract every provider module must satisfy.
 *
 * Discriminated on `programmaticWebhooks`:
 * - `true`  -> `onDisconnect` is **required** (compile-time enforced)
 * - `false` / omitted -> `onDisconnect` is optional
 */
export type ProviderPlugin = ProgrammaticWebhookProvider | PassiveWebhookProvider;

// ──────────────────────────────────────────────────────────────────────────────
// Webhook Plugin
// ──────────────────────────────────────────────────────────────────────────────

export interface WebhookContext {
  convex: ReturnType<typeof getConvexClientFromUrl>;
  apiSecret: string;
  encryptionSecret: string;
}

export interface WebhookPlugin {
  handle(
    request: Request,
    routeId: string,
    urlProviderId: string,
    ctx: WebhookContext
  ): Promise<Response>;
  readonly extraProviders?: readonly string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Disconnect Hook
// ──────────────────────────────────────────────────────────────────────────────

/** Context passed to a provider's onDisconnect hook */
export interface DisconnectContext {
  /** Encrypted credentials from the provider_credentials table */
  credentials: Record<string, string>;
  encryptionSecret: string;
  apiBaseUrl: string;
  /** Remote webhook ID stored on the connection (e.g. LemonSqueezy webhook ID) */
  remoteWebhookId?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// License Verification Plugin
// ──────────────────────────────────────────────────────────────────────────────

export interface LicenseVerificationResult {
  valid: boolean;
  externalOrderId?: string;
  providerUserId?: string;
  providerProductId?: string;
  error?: string;
}

export interface LicenseVerificationPlugin {
  verifyLicense(
    licenseKey: string,
    productId: string | undefined,
    authUserId: string,
    ctx: ProviderContext
  ): Promise<LicenseVerificationResult | null>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Connect Plugin
// ──────────────────────────────────────────────────────────────────────────────

export interface ConnectConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexSiteUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  discordBotToken?: string;
  convexApiSecret: string;
  convexUrl: string;
  gumroadClientId?: string;
  gumroadClientSecret?: string;
  encryptionSecret: string;
}

type SetupSession = { authUserId: string; guildId: string; discordUserId: string };
type AuthSession = NonNullable<Awaited<ReturnType<Auth['getSession']>>>;

export type BoundSetupResult =
  | { ok: true; setupSession: SetupSession; authSession: AuthSession; authDiscordUserId: string }
  | { ok: false; response: Response };

export interface ConnectContext {
  readonly config: ConnectConfig;
  readonly auth: Auth;
  requireBoundSetupSession(request: Request): Promise<BoundSetupResult>;
  getSetupSessionTokenFromRequest(request: Request): string | null;
  isTenantOwnedBySessionUser(sessionUserId: string, authUserId: string): Promise<boolean>;
}

export interface ConnectRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (request: Request, ctx: ConnectContext) => Promise<Response>;
}

export interface ConnectPlugin {
  readonly providerId: string;
  readonly routes: ReadonlyArray<ConnectRoute>;
}

export function generateSecureRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Thrown by a ProviderPlugin when the stored credential is rejected by the external API (HTTP 401).
 * The API router catches this, marks the connection as 'degraded' in Convex, and returns
 * error: "session_expired" to the caller so the bot can surface a reconnect prompt.
 */
export class CredentialExpiredError extends Error {
  constructor(public readonly provider: string) {
    super(`Credential expired for provider: ${provider}`);
    this.name = 'CredentialExpiredError';
  }
}

export interface ConnectDisplayMeta {
  /** Human-readable provider name for UI */
  readonly label: string;
  /** Image filename under /Icons/ */
  readonly icon: string;
  /** CSS background color for the connect button (not connected state) */
  readonly color: string;
  /** CSS box-shadow color */
  readonly shadowColor: string;
  /** CSS text color — '#000000' for dark buttons, '#ffffff' for light */
  readonly textColor: string;
  /** CSS background color when connected */
  readonly connectedColor: string;
  /** Colors for confetti animation */
  readonly confettiColors: readonly string[];
  /** Short description shown below label */
  readonly description: string;
  /** URL path to initiate the dashboard connect flow */
  readonly dashboardConnectPath: string;
  /**
   * Query-param naming convention expected by the connect endpoint.
   * 'camelCase' → tenantId + guildId (used by /api/connect/* routes)
   * 'snakeCase' → tenant_id + guild_id (used by legacy setup pages)
   */
  readonly dashboardConnectParamStyle: 'camelCase' | 'snakeCase';
  /** Background color for the provider icon container in the dashboard */
  readonly dashboardIconBg: string;
  /** Background style for the quick-start connect button */
  readonly dashboardQuickStartBg: string;
  /** Border style for the quick-start connect button */
  readonly dashboardQuickStartBorder: string;
  /** Hint text shown on the server configuration tile */
  readonly dashboardServerTileHint: string;
}
