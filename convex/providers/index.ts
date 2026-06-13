import type {
  LicenseVerificationResult,
  ProviderContext,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
} from '@yucp/providers/contracts';
import type { ConvexProviderRuntimePorts } from '@yucp/providers/convexRuntime';
import type { ActionCtx } from '../_generated/server';
import gumroad from '@yucp/providers/gumroad/convex';
import jinxxy from '@yucp/providers/jinxxy/convex';
import lemonsqueezy from '@yucp/providers/lemonsqueezy/convex';
import payhip from '@yucp/providers/payhip/convex';
import {
  buildProviderContext,
  decryptStoredCredential,
  loadCollaboratorConnections,
  loadPayhipProductSecretKeys,
  loadPrimaryCredential,
  providerRuntimeLogger,
} from './shared';

type ManualLicenseProviderEntry = {
  id: SupportedManualLicenseProvider;
  createRuntime(ports: ConvexProviderRuntimePorts): ProviderRuntimeModule<never, ProviderRuntimeClient>;
};

type SupportedManualLicenseProvider = 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'payhip';

export type ProviderLicenseVerificationResult = {
  valid: boolean;
  providerUserId?: string;
  externalOrderId?: string;
  providerProductId?: string;
  reason?: string;
};

function defineProviderRegistry<TRegistry extends Record<SupportedManualLicenseProvider, ManualLicenseProviderEntry>>(
  registry: TRegistry
): TRegistry {
  for (const [providerKey, entry] of Object.entries(registry)) {
    if (entry.id !== providerKey) {
      throw new Error(`Provider registry key "${providerKey}" does not match runtime id "${entry.id}"`);
    }
  }
  return registry;
}

const PROVIDER_ENTRIES = defineProviderRegistry({
  gumroad,
  jinxxy,
  lemonsqueezy,
  payhip,
});

function getManualLicenseRuntime(
  id: string,
  ports: ConvexProviderRuntimePorts
): ProviderRuntimeModule<never> | undefined {
  const entry = PROVIDER_ENTRIES[id as SupportedManualLicenseProvider];
  return entry?.createRuntime(ports);
}

function toProviderVerificationResult(
  result: LicenseVerificationResult | null
): ProviderLicenseVerificationResult | null {
  if (!result) {
    return null;
  }
  return {
    valid: result.valid,
    providerUserId: result.providerUserId,
    externalOrderId: result.externalOrderId,
    providerProductId: result.providerProductId,
    reason: result.error,
  };
}

export async function verifyLicenseWithProviderRuntime(
  ctx: ActionCtx,
  input: {
    provider: string;
    licenseKey: string;
    providerProductRef: string;
    authUserId: string;
  }
): Promise<ProviderLicenseVerificationResult | null> {
  const providerCtx = buildProviderContext(input.authUserId);
  const runtimePorts: ConvexProviderRuntimePorts = {
    logger: providerRuntimeLogger,
    async loadPrimaryCredential(authUserId, provider) {
      return await loadPrimaryCredential(ctx, authUserId, provider);
    },
    async loadCollaboratorConnections(ownerAuthUserId) {
      return await loadCollaboratorConnections(ctx, ownerAuthUserId);
    },
    async loadProductSecretKeys(authUserId, provider) {
      if (provider !== 'payhip') {
        return [];
      }
      return await loadPayhipProductSecretKeys(ctx, authUserId);
    },
    async decryptStoredCredential(encryptedCredential, purpose, _providerCtx: ProviderContext) {
      return await decryptStoredCredential(encryptedCredential, purpose);
    },
  };

  const runtime = getManualLicenseRuntime(input.provider, runtimePorts);
  if (!runtime?.verification) {
    return null;
  }
  const result = await runtime.verification.verifyLicense(
    input.licenseKey,
    input.providerProductRef,
    input.authUserId,
    providerCtx
  );
  return toProviderVerificationResult(result ?? null);
}
