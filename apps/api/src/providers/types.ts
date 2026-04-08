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
import type { Id } from '../../../../convex/_generated/dataModel';
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
  readonly buyerLink?: BuyerLinkPlugin;
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
  itchioClientId?: string;
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

export interface BuyerLinkIdentity {
  providerUserId: string;
  username?: string;
  email?: string;
  avatarUrl?: string;
  profileUrl?: string;
  expiresAt?: number;
}

export interface BuyerLinkOAuthConfig {
  providerId: string;
  mode: string;
  aliases?: readonly string[];
  authUrl: string;
  tokenUrl: string;
  responseType?: 'code' | 'token';
  usesPkce?: boolean;
  scopes: readonly string[];
  callbackPath: string;
  callbackOrigin?: 'api' | 'frontend';
  callbackHandler?: 'verification-route' | 'connect-plugin';
  clientIdKey?: string;
  clientSecretKey?: string;
  extraOAuthParams?: Readonly<Record<string, string>>;
}

export interface StoreBuyerLinkCredentialInput {
  externalAccountId: Id<'external_accounts'>;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  grantedScopes?: readonly string[];
}

export interface VerifyHostedBuyerLinkIntentInput {
  authUserId: string;
  intentId: Id<'verification_intents'>;
  methodKey: string;
}

export interface VerifyHostedBuyerLinkIntentResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface BuyerLinkPostLinkInput {
  authUserId: string;
  sessionId: Id<'verification_sessions'>;
  sessionMode: string;
  verificationMethod?: string;
  discordUserId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  grantedScopes?: readonly string[];
  identity: BuyerLinkIdentity;
  subjectId: Id<'subjects'>;
  externalAccountId: Id<'external_accounts'>;
}

export interface BuyerLinkPlugin {
  readonly oauth: BuyerLinkOAuthConfig;
  fetchIdentity(accessToken: string, ctx: BuyerVerificationContext): Promise<BuyerLinkIdentity>;
  storeCredential?(
    input: StoreBuyerLinkCredentialInput,
    ctx: BuyerVerificationContext
  ): Promise<void>;
  afterLink?(input: BuyerLinkPostLinkInput, ctx: BuyerVerificationContext): Promise<void>;
  verifyHostedIntent?(
    input: VerifyHostedBuyerLinkIntentInput,
    ctx: BuyerVerificationContext
  ): Promise<VerifyHostedBuyerLinkIntentResult>;
}

export function generateSecureRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
