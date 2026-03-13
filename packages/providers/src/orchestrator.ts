/**
 * Verification Orchestrator
 *
 * Standardizes verification operations across different providers.
 * Routes verification requests by tenant-enabled provider modes.
 * Handles graceful fallback and provider health checks.
 *
 * @example
 * ```ts
 * const orchestrator = new VerificationOrchestrator(registry, {
 *   getTenantConfig: async (authUserId) => ({
 *     enabledModes: ['gumroad', 'jinxxy'],
 *   }),
 * });
 *
 * // Begin verification
 * const result = await orchestrator.beginVerification('tenant-123', 'gumroad', {
 *   subjectId: 'user-456',
 *   redirectUri: 'https://example.com/callback',
 * });
 *
 * // Complete verification
 * const verification = await orchestrator.completeVerification('session-789', 'auth-code');
 *
 * // Refresh verification
 * const refreshed = await orchestrator.refreshVerification('binding-123');
 *
 * // Revoke verification
 * await orchestrator.revokeVerification('binding-123');
 * ```
 */

import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, ProviderConfig, PurchaseRecord } from './index';
import type { ProviderMode, ProviderRegistry } from './registry';

// ============================================================================
// Types
// ============================================================================

/** Context for beginning a verification */
export interface BeginVerificationContext {
  /** Subject ID (YUCP user ID) */
  subjectId?: string;
  /** Redirect URI for OAuth callbacks */
  redirectUri?: string;
  /** Additional scopes to request */
  scope?: string;
  /** Product ID to verify */
  productId?: string;
  /** Buyer email or Discord ID */
  buyerIdentifier?: string;
  /** Custom state data to pass through */
  customState?: Record<string, unknown>;
}

/** Result of beginning a verification */
export interface BeginVerificationResult {
  /** Success status */
  success: boolean;
  /** Verification session ID for tracking */
  verificationSessionId: string;
  /** OAuth authorization URL (for OAuth providers) */
  authorizationUrl?: string;
  /** State parameter for CSRF protection */
  state?: string;
  /** Provider mode used */
  mode: ProviderMode;
  /** Error message if failed */
  error?: string;
}

/** Context for completing a verification */
export interface CompleteVerificationContext {
  /** Authorization code from OAuth callback */
  code?: string;
  /** State parameter from OAuth callback */
  state?: string;
  /** License key for manual verification */
  licenseKey?: string;
  /** Buyer email or Discord ID */
  buyerIdentifier?: string;
  /** Product ID to verify */
  productId?: string;
}

/** Result of completing a verification */
export interface CompleteVerificationResult {
  /** Success status */
  success: boolean;
  /** Verification record */
  verification?: Verification;
  /** Provider-specific evidence */
  evidence?: PurchaseRecord;
  /** Provider mode used */
  mode: ProviderMode;
  /** Provider user ID (e.g., Gumroad user ID, Discord user ID) */
  providerUserId?: string;
  /** Error message if failed */
  error?: string;
}

/** Context for refreshing a verification */
export interface RefreshVerificationContext {
  /** Binding ID to refresh */
  bindingId: string;
  /** Force refresh even if not expired */
  force?: boolean;
}

/** Result of refreshing a verification */
export interface RefreshVerificationResult {
  /** Success status */
  success: boolean;
  /** Updated verification */
  verification?: Verification;
  /** Whether the verification is still valid */
  isValid?: boolean;
  /** Error message if failed */
  error?: string;
}

/** Context for revoking a verification */
export interface RevokeVerificationContext {
  /** Binding ID to revoke */
  bindingId: string;
  /** Reason for revocation */
  reason?: string;
  /** Notify the provider (e.g., revoke OAuth tokens) */
  notifyProvider?: boolean;
}

/** Result of revoking a verification */
export interface RevokeVerificationResult {
  /** Success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/** Tenant configuration for verification routing */
export interface TenantVerificationConfig {
  /** Enabled provider modes for this tenant */
  enabledModes: ProviderMode[];
  /** Primary provider mode (used as default) */
  primaryMode?: ProviderMode;
  /** Fallback order if primary fails */
  fallbackOrder?: ProviderMode[];
  /** Provider-specific configuration */
  providerConfig?: Partial<Record<ProviderMode, ProviderConfig>>;
}

/** Function to get tenant configuration */
export type GetTenantConfig = (authUserId: string) => Promise<TenantVerificationConfig | null>;

/** Verification session stored during OAuth flow */
export interface VerificationSession {
  /** Session ID */
  id: string;
  /** Auth user ID */
  authUserId: string;
  /** Provider mode */
  mode: ProviderMode;
  /** Subject ID (YUCP user) */
  subjectId?: string;
  /** OAuth state parameter */
  state?: string;
  /** PKCE code verifier */
  codeVerifier?: string;
  /** Created at */
  createdAt: Date;
  /** Expires at */
  expiresAt: Date;
  /** Custom state data */
  customState?: Record<string, unknown>;
}

/** Storage interface for verification sessions */
export interface VerificationSessionStorage {
  /** Store a verification session */
  store(session: VerificationSession): Promise<void>;
  /** Get a verification session by ID */
  get(sessionId: string): Promise<VerificationSession | null>;
  /** Get a verification session by state */
  getByState(state: string): Promise<VerificationSession | null>;
  /** Delete a verification session */
  delete(sessionId: string): Promise<void>;
}

/** Storage interface for verification bindings */
export interface VerificationBindingStorage {
  /** Get binding by ID */
  get(bindingId: string): Promise<{
    id: string;
    authUserId: string;
    mode: ProviderMode;
    providerUserId?: string;
    verification: Verification;
  } | null>;
  /** Update binding verification status */
  update(bindingId: string, verification: Verification): Promise<void>;
  /** Delete binding */
  delete(bindingId: string): Promise<void>;
}

/** In-memory session storage implementation (for development/testing) */
export class InMemorySessionStorage implements VerificationSessionStorage {
  private sessions = new Map<string, VerificationSession>();
  private stateIndex = new Map<string, string>();

  async store(session: VerificationSession): Promise<void> {
    this.sessions.set(session.id, session);
    if (session.state) {
      this.stateIndex.set(session.state, session.id);
    }
    // Clean up expired sessions
    const now = new Date();
    for (const [id, s] of this.sessions.entries()) {
      if (s.expiresAt < now) {
        this.sessions.delete(id);
        if (s.state) {
          this.stateIndex.delete(s.state);
        }
      }
    }
  }

  async get(sessionId: string): Promise<VerificationSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      this.sessions.delete(sessionId);
      if (session.state) {
        this.stateIndex.delete(session.state);
      }
      return null;
    }
    return session;
  }

  async getByState(state: string): Promise<VerificationSession | null> {
    const sessionId = this.stateIndex.get(state);
    if (!sessionId) return null;
    return this.get(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.state) {
      this.stateIndex.delete(session.state);
    }
    this.sessions.delete(sessionId);
  }
}

/** Orchestrator options */
export interface VerificationOrchestratorOptions {
  /** Function to get tenant configuration */
  getTenantConfig: GetTenantConfig;
  /** Session storage (defaults to in-memory) */
  sessionStorage?: VerificationSessionStorage;
  /** Binding storage (required for refresh/revoke) */
  bindingStorage?: VerificationBindingStorage;
  /** Session expiration time in milliseconds (default 10 minutes) */
  sessionExpiryMs?: number;
  /** Whether to check provider health before routing */
  checkProviderHealth?: boolean;
}

// ============================================================================
// Verification Orchestrator
// ============================================================================

/**
 * Verification Orchestrator
 *
 * Standardizes verification operations across different providers.
 */
export class VerificationOrchestrator {
  private readonly sessionStorage: VerificationSessionStorage;
  private readonly sessionExpiryMs: number;
  private readonly checkProviderHealth: boolean;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly options: VerificationOrchestratorOptions
  ) {
    this.sessionStorage = options.sessionStorage ?? new InMemorySessionStorage();
    this.sessionExpiryMs = options.sessionExpiryMs ?? 10 * 60 * 1000; // 10 minutes
    this.checkProviderHealth = options.checkProviderHealth ?? true;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Begin a verification flow for a tenant.
   *
   * @param authUserId - Auth user ID
   * @param mode - Provider mode to use
   * @param context - Verification context
   */
  async beginVerification(
    authUserId: string,
    mode: ProviderMode,
    context: BeginVerificationContext
  ): Promise<BeginVerificationResult> {
    // Get tenant configuration
    const tenantConfig = await this.options.getTenantConfig(authUserId);
    if (!tenantConfig) {
      return {
        success: false,
        verificationSessionId: '',
        mode,
        error: 'Creator not found',
      };
    }

    // Check if mode is enabled for tenant
    if (!tenantConfig.enabledModes.includes(mode)) {
      return {
        success: false,
        verificationSessionId: '',
        mode,
        error: `Provider mode '${mode}' is not enabled for this tenant`,
      };
    }

    // Check provider health if enabled
    if (this.checkProviderHealth) {
      const health = await this.registry.healthCheck(mode);
      if (!health.healthy) {
        // Try fallback providers
        const fallbackResult = await this.tryFallbackBegin(authUserId, mode, tenantConfig, context);
        if (fallbackResult) {
          return fallbackResult;
        }

        return {
          success: false,
          verificationSessionId: '',
          mode,
          error: `Provider '${mode}' is unhealthy: ${health.error}`,
        };
      }
    }

    // Get provider adapter
    const adapter = this.registry.getProvider(mode);
    if (!adapter) {
      return {
        success: false,
        verificationSessionId: '',
        mode,
        error: `Provider '${mode}' is not registered`,
      };
    }

    // Generate verification session
    const verificationSessionId = crypto.randomUUID();
    const now = new Date();

    const session: VerificationSession = {
      id: verificationSessionId,
      authUserId,
      mode,
      subjectId: context.subjectId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.sessionExpiryMs),
      customState: context.customState,
    };

    try {
      // Route to provider-specific begin implementation
      const result = await this.beginProviderVerification(
        adapter,
        mode,
        session,
        context,
        tenantConfig
      );

      if (result.success) {
        // Store session
        session.state = result.state;
        await this.sessionStorage.store(session);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        verificationSessionId,
        mode,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Complete a verification flow.
   *
   * @param sessionId - Verification session ID
   * @param context - Completion context
   */
  async completeVerification(
    sessionId: string,
    context: CompleteVerificationContext
  ): Promise<CompleteVerificationResult> {
    // Get session
    let session = await this.sessionStorage.get(sessionId);

    // If not found by ID, try to find by state (for OAuth callbacks)
    if (!session && context.state) {
      session = await this.sessionStorage.getByState(context.state);
    }

    if (!session) {
      return {
        success: false,
        mode: 'gumroad', // Default
        error: 'Invalid or expired verification session',
      };
    }

    // Check session expiration
    if (session.expiresAt < new Date()) {
      await this.sessionStorage.delete(session.id);
      return {
        success: false,
        mode: session.mode,
        error: 'Verification session has expired',
      };
    }

    // Get provider adapter
    const adapter = this.registry.getProvider(session.mode);
    if (!adapter) {
      return {
        success: false,
        mode: session.mode,
        error: `Provider '${session.mode}' is not registered`,
      };
    }

    try {
      // Route to provider-specific complete implementation
      const result = await this.completeProviderVerification(
        adapter,
        session.mode,
        session,
        context
      );

      // Clean up session
      await this.sessionStorage.delete(session.id);

      return result;
    } catch (error) {
      return {
        success: false,
        mode: session.mode,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Refresh a verification (re-verify with provider).
   *
   * @param bindingId - Binding ID to refresh
   */
  async refreshVerification(bindingId: string): Promise<RefreshVerificationResult> {
    if (!this.options.bindingStorage) {
      return {
        success: false,
        error: 'Binding storage not configured',
      };
    }

    const binding = await this.options.bindingStorage.get(bindingId);
    if (!binding) {
      return {
        success: false,
        error: 'Binding not found',
      };
    }

    // Get provider adapter
    const adapter = this.registry.getProvider(binding.mode);
    if (!adapter) {
      return {
        success: false,
        error: `Provider '${binding.mode}' is not registered`,
      };
    }

    try {
      // Route to provider-specific refresh implementation
      const result = await this.refreshProviderVerification(adapter, binding.mode, binding);

      // Update binding if successful
      if (result.success && result.verification) {
        await this.options.bindingStorage.update(bindingId, result.verification);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Revoke a verification.
   *
   * @param bindingId - Binding ID to revoke
   * @param context - Revocation context
   */
  async revokeVerification(
    bindingId: string,
    context?: RevokeVerificationContext
  ): Promise<RevokeVerificationResult> {
    if (!this.options.bindingStorage) {
      return {
        success: false,
        error: 'Binding storage not configured',
      };
    }

    const binding = await this.options.bindingStorage.get(bindingId);
    if (!binding) {
      return {
        success: false,
        error: 'Binding not found',
      };
    }

    // Get provider adapter
    const adapter = this.registry.getProvider(binding.mode);
    if (!adapter) {
      return {
        success: false,
        error: `Provider '${binding.mode}' is not registered`,
      };
    }

    try {
      // Route to provider-specific revoke implementation
      const result = await this.revokeProviderVerification(adapter, binding.mode, binding, context);

      // Delete binding if successful
      if (result.success) {
        await this.options.bindingStorage.delete(bindingId);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get enabled provider modes for a tenant.
   *
   * @param authUserId - Auth user ID
   */
  async getEnabledModes(authUserId: string): Promise<ProviderMode[]> {
    const config = await this.options.getTenantConfig(authUserId);
    return config?.enabledModes ?? [];
  }

  /**
   * Check if a specific mode is enabled for a tenant.
   *
   * @param authUserId - Auth user ID
   * @param mode - Provider mode
   */
  async isModeEnabled(authUserId: string, mode: ProviderMode): Promise<boolean> {
    const config = await this.options.getTenantConfig(authUserId);
    return config?.enabledModes.includes(mode) ?? false;
  }

  // ============================================================================
  // Private: Provider-Specific Routing
  // ============================================================================

  private async beginProviderVerification(
    adapter: ProviderAdapter,
    mode: ProviderMode,
    session: VerificationSession,
    context: BeginVerificationContext,
    _tenantConfig: TenantVerificationConfig
  ): Promise<BeginVerificationResult> {
    switch (mode) {
      case 'gumroad': {
        // GumroadAdapter has beginVerification
        const gumroadAdapter = adapter as unknown as {
          beginVerification?: (
            authUserId: string,
            subjectId?: string,
            options?: { scope?: string }
          ) => Promise<{ authorizationUrl: string; state: string }>;
        };

        if (gumroadAdapter.beginVerification) {
          const result = await gumroadAdapter.beginVerification(
            session.authUserId,
            context.subjectId,
            { scope: context.scope }
          );
          return {
            success: true,
            verificationSessionId: session.id,
            authorizationUrl: result.authorizationUrl,
            state: result.state,
            mode,
          };
        }
        break;
      }

      case 'discord_role': {
        // DiscordOAuthProvider has beginVerification
        const discordAdapter = adapter as unknown as {
          beginVerification?: () => Promise<{
            authorizationUrl: string;
            state: string;
            verificationSessionId: string;
          }>;
        };

        if (discordAdapter.beginVerification) {
          const result = await discordAdapter.beginVerification();
          return {
            success: true,
            verificationSessionId: result.verificationSessionId || session.id,
            authorizationUrl: result.authorizationUrl,
            state: result.state,
            mode,
          };
        }
        break;
      }

      case 'jinxxy':
      case 'manual': {
        // Jinxxy and Manual don't use OAuth - direct verification
        return {
          success: true,
          verificationSessionId: session.id,
          mode,
        };
      }
    }

    return {
      success: false,
      verificationSessionId: session.id,
      mode,
      error: `Begin verification not supported for provider '${mode}'`,
    };
  }

  private async completeProviderVerification(
    adapter: ProviderAdapter,
    mode: ProviderMode,
    session: VerificationSession,
    context: CompleteVerificationContext
  ): Promise<CompleteVerificationResult> {
    switch (mode) {
      case 'gumroad': {
        const gumroadAdapter = adapter as unknown as {
          completeVerification?: (
            code: string,
            state: string
          ) => Promise<{
            success: boolean;
            gumroadUserId?: string;
            error?: string;
          }>;
        };

        if (gumroadAdapter.completeVerification && context.code && context.state) {
          const result = await gumroadAdapter.completeVerification(context.code, context.state);

          if (result.success) {
            return {
              success: true,
              mode,
              providerUserId: result.gumroadUserId,
              verification: {
                id: crypto.randomUUID(),
                userId: session.subjectId ?? '',
                provider: 'gumroad',
                status: 'verified',
                createdAt: new Date(),
              },
            };
          }

          return {
            success: false,
            mode,
            error: result.error,
          };
        }
        break;
      }

      case 'discord_role': {
        const discordAdapter = adapter as unknown as {
          completeVerification?: (
            code: string,
            state: string,
            verificationSessionId: string
          ) => Promise<{
            user: { id: string };
            error?: string;
          }>;
        };

        if (discordAdapter.completeVerification && context.code && session.state) {
          const result = await discordAdapter.completeVerification(
            context.code,
            session.state,
            session.id
          );

          return {
            success: true,
            mode,
            providerUserId: result.user?.id,
            verification: {
              id: crypto.randomUUID(),
              userId: session.subjectId ?? '',
              provider: 'discord',
              status: 'verified',
              createdAt: new Date(),
            },
          };
        }
        break;
      }

      case 'jinxxy': {
        if (context.buyerIdentifier) {
          const verification = await adapter.verifyPurchase(context.buyerIdentifier);

          if (verification) {
            return {
              success: true,
              mode,
              verification,
            };
          }

          return {
            success: false,
            mode,
            error: 'No valid purchases found for this buyer',
          };
        }
        break;
      }

      case 'manual': {
        if (context.licenseKey && context.productId) {
          const manualAdapter = adapter as unknown as {
            validateLicense?: (input: {
              licenseKey: string;
              productId: string;
              authUserId: string;
            }) => Promise<{
              valid: boolean;
              license?: { _id: string; createdAt: string };
              error?: string;
            }>;
          };

          if (manualAdapter.validateLicense) {
            const result = await manualAdapter.validateLicense({
              licenseKey: context.licenseKey,
              productId: context.productId,
              authUserId: session.authUserId,
            });

            if (result.valid && result.license) {
              return {
                success: true,
                mode,
                verification: {
                  id: result.license._id,
                  userId: session.subjectId ?? '',
                  provider: 'manual',
                  status: 'verified',
                  createdAt: new Date(result.license.createdAt),
                },
              };
            }

            return {
              success: false,
              mode,
              error: result.error ?? 'Invalid license key',
            };
          }
        }
        break;
      }
    }

    return {
      success: false,
      mode,
      error: `Complete verification not supported for provider '${mode}'`,
    };
  }

  private async refreshProviderVerification(
    adapter: ProviderAdapter,
    mode: ProviderMode,
    binding: {
      id: string;
      authUserId: string;
      mode: ProviderMode;
      providerUserId?: string;
      verification: Verification;
    }
  ): Promise<RefreshVerificationResult> {
    switch (mode) {
      case 'gumroad': {
        const _gumroadAdapter = adapter as unknown as {
          checkPurchaseStatus?: (
            accessToken: string,
            saleId: string
          ) => Promise<{
            found: boolean;
            status: 'active' | 'refunded' | 'chargebacked' | 'disputed' | 'unknown';
          }>;
        };

        // For Gumroad, we'd need to re-check purchase status
        // This requires stored access tokens
        return {
          success: true,
          isValid: true,
          verification: binding.verification,
        };
      }

      case 'discord_role': {
        const discordAdapter = adapter as unknown as {
          refreshTokens?: (sessionId: string) => Promise<unknown>;
          isTokenExpired?: (sessionId: string) => Promise<boolean>;
        };

        if (discordAdapter.isTokenExpired) {
          const isExpired = await discordAdapter.isTokenExpired(binding.id);
          return {
            success: true,
            isValid: !isExpired,
            verification: binding.verification,
          };
        }
        break;
      }

      case 'jinxxy': {
        const jinxxyAdapter = adapter as unknown as {
          checkLicenseStatus?: (licenseId: string) => Promise<{ found: boolean; valid: boolean }>;
        };

        if (jinxxyAdapter.checkLicenseStatus && binding.providerUserId) {
          const result = await jinxxyAdapter.checkLicenseStatus(binding.providerUserId);
          return {
            success: true,
            isValid: result.valid,
            verification: {
              ...binding.verification,
              status: result.valid ? 'verified' : 'rejected',
            },
          };
        }
        break;
      }

      case 'manual': {
        const _manualAdapter = adapter as unknown as {
          validateLicense?: (input: {
            licenseKey: string;
            productId: string;
            authUserId: string;
          }) => Promise<{ valid: boolean }>;
        };

        // For manual licenses, re-validation would require the license key
        return {
          success: true,
          isValid: binding.verification.status === 'verified',
          verification: binding.verification,
        };
      }
    }

    return {
      success: false,
      error: `Refresh verification not supported for provider '${mode}'`,
    };
  }

  private async revokeProviderVerification(
    adapter: ProviderAdapter,
    mode: ProviderMode,
    binding: {
      id: string;
      authUserId: string;
      mode: ProviderMode;
      providerUserId?: string;
    },
    context?: RevokeVerificationContext
  ): Promise<RevokeVerificationResult> {
    const notifyProvider = context?.notifyProvider ?? true;

    switch (mode) {
      case 'gumroad': {
        const gumroadAdapter = adapter as unknown as {
          revokeAccess?: (authUserId: string, gumroadUserId: string) => Promise<void>;
        };

        if (notifyProvider && gumroadAdapter.revokeAccess && binding.providerUserId) {
          await gumroadAdapter.revokeAccess(binding.authUserId, binding.providerUserId);
        }
        return { success: true };
      }

      case 'discord_role': {
        const discordAdapter = adapter as unknown as {
          revokeTokens?: (sessionId: string) => Promise<void>;
        };

        if (notifyProvider && discordAdapter.revokeTokens) {
          await discordAdapter.revokeTokens(binding.id);
        }
        return { success: true };
      }

      case 'jinxxy': {
        // Jinxxy doesn't have a revoke API - just mark as revoked locally
        return { success: true };
      }

      case 'manual': {
        const manualAdapter = adapter as unknown as {
          revokeLicense?: (input: {
            licenseId: string;
            authUserId: string;
            reason?: string;
          }) => Promise<unknown>;
        };

        if (manualAdapter.revokeLicense) {
          await manualAdapter.revokeLicense({
            licenseId: binding.id,
            authUserId: binding.authUserId,
            reason: context?.reason,
          });
        }
        return { success: true };
      }
    }

    return { success: true };
  }

  // ============================================================================
  // Private: Fallback Handling
  // ============================================================================

  private async tryFallbackBegin(
    authUserId: string,
    failedMode: ProviderMode,
    tenantConfig: TenantVerificationConfig,
    context: BeginVerificationContext
  ): Promise<BeginVerificationResult | null> {
    const fallbackOrder = tenantConfig.fallbackOrder ?? tenantConfig.enabledModes;

    for (const fallbackMode of fallbackOrder) {
      if (fallbackMode === failedMode) continue;

      // Check health of fallback provider
      const health = await this.registry.healthCheck(fallbackMode);
      if (!health.healthy) continue;

      // Try to begin verification with fallback
      const result = await this.beginVerification(authUserId, fallbackMode, context);
      if (result.success) {
        return result;
      }
    }

    return null;
  }
}
