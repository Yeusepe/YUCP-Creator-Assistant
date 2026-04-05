/**
 * Provider Plugin Architecture
 *
 * Runtime provider behavior is now owned by @yucp/providers/contracts.
 * apps/api extends that contract with the HTTP-only connect/webhook hooks that
 * still belong to the API transport layer during the ongoing provider cutover.
 */

import type { BackfillRecord } from '@yucp/application/ports';
import type {
  BuyerVerificationCapabilityDescriptor,
  BuyerVerificationCapabilityInput,
  BuyerVerificationMethodKind,
  BuyerVerificationResult,
  BuyerVerificationSubmission,
  ConnectDisplayMeta,
  DisconnectContext,
  LicenseVerificationResult,
  ProductRecord,
  BackfillPlugin as ProviderBackfillPlugin,
  ProviderPurposes,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
  BuyerVerificationAdapter as RuntimeBuyerVerificationAdapter,
  BuyerVerificationContext as RuntimeBuyerVerificationContext,
  LicenseVerificationPlugin as RuntimeLicenseVerificationPlugin,
  ProviderContext as RuntimeProviderContext,
} from '@yucp/providers/contracts';
import { CredentialExpiredError } from '@yucp/providers/contracts';
import type { RuntimeProviderKey } from '@yucp/providers/types';
import type { Auth } from '../auth';
import type { getConvexClientFromUrl } from '../lib/convex';

type ApiProviderRuntimeClient = ReturnType<typeof getConvexClientFromUrl>;

export type ProviderId = RuntimeProviderKey;
export type ProviderContext = RuntimeProviderContext<ApiProviderRuntimeClient>;
export type BuyerVerificationContext = RuntimeBuyerVerificationContext<ApiProviderRuntimeClient>;
export type BuyerVerificationAdapter = RuntimeBuyerVerificationAdapter<ApiProviderRuntimeClient>;
export type LicenseVerificationPlugin = RuntimeLicenseVerificationPlugin<ApiProviderRuntimeClient>;
export type ProviderRuntime = ProviderRuntimeModule<BackfillRecord, ApiProviderRuntimeClient>;

export type {
  BackfillRecord,
  BuyerVerificationCapabilityDescriptor,
  BuyerVerificationCapabilityInput,
  BuyerVerificationMethodKind,
  BuyerVerificationResult,
  BuyerVerificationSubmission,
  ConnectDisplayMeta,
  DisconnectContext,
  LicenseVerificationResult,
  ProductRecord,
  ProviderPurposes,
  ProviderRuntimeModule,
  ProviderRuntimeClient,
};
export { CredentialExpiredError };

/** Optional backfill capability — providers that don't support backfill omit this. */
export type BackfillPlugin = ProviderBackfillPlugin<BackfillRecord>;

interface BaseApiProviderHooks {
  readonly webhook?: WebhookPlugin;
  readonly connect?: ConnectPlugin;
}

/**
 * Provider that programmatically creates webhooks on the external platform
 * during its connect flow (e.g. Gumroad resource_subscriptions, LemonSqueezy webhooks).
 *
 * MUST implement onDisconnect to clean up those webhooks when the connection
 * is removed, preventing stale webhook traffic.
 */
interface ProgrammaticWebhookHooks extends BaseApiProviderHooks {
  readonly programmaticWebhooks: true;
  /** REQUIRED: cleanup external webhooks before the connection is soft-deleted. */
  onDisconnect(ctx: DisconnectContext): Promise<void>;
}

/**
 * Provider that either receives webhooks passively (user configures URL manually)
 * or does not use webhooks at all.
 */
interface PassiveWebhookHooks extends BaseApiProviderHooks {
  readonly programmaticWebhooks?: false;
  /** Optional cleanup hook. */
  onDisconnect?(ctx: DisconnectContext): Promise<void>;
}

export type ApiProviderHooks = ProgrammaticWebhookHooks | PassiveWebhookHooks;

export interface ApiProviderEntry {
  readonly runtime: ProviderRuntime;
  readonly hooks: ApiProviderHooks;
}

export function defineApiProviderEntry<TEntry extends ApiProviderEntry>(entry: TEntry): TEntry {
  return entry;
}

// ──────────────────────────────────────────────────────────────────────────────
// Webhook Plugin
// ──────────────────────────────────────────────────────────────────────────────

export interface WebhookContext {
  convex: ApiProviderRuntimeClient;
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

export type BoundSetupResult =
  | { ok: true; setupSession: SetupSession }
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
