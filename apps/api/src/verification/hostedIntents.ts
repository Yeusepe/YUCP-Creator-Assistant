import type { HostedVerificationProviderDescriptor } from '@yucp/application/ports';
import {
  type HostedVerificationIntentRecord,
  HostedVerificationService,
  type StoredVerificationIntentRequirement,
  type VerificationIntentRequirementInput,
} from '@yucp/application/services';
import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { api, internal } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexServerClient } from '../lib/convex';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProviderHooks, getProviderRuntime } from '../providers';
import { getVerificationConfig } from './verificationConfig';

function resolveHostedVerificationProvider(
  providerKey: string
): HostedVerificationProviderDescriptor | undefined {
  const descriptor = getProviderDescriptor(providerKey);
  if (!descriptor) {
    return undefined;
  }

  return {
    label: descriptor.label,
    buyerVerificationMethods: descriptor.buyerVerificationMethods,
    supportsHostedBuyerAccountLink: Boolean(
      descriptor.supportsBuyerOAuthLink && getVerificationConfig(providerKey)
    ),
    describeManualLicenseCapability: () =>
      getProviderRuntime(providerKey)?.buyerVerification?.describeCapability('manual_license') ??
      null,
  };
}

const hostedVerificationService = new HostedVerificationService({
  providers: {
    getProvider: resolveHostedVerificationProvider,
  },
});

export type {
  HostedVerificationIntentRecord,
  StoredVerificationIntentRequirement,
  VerificationIntentRequirementInput,
};

export function normalizeHostedVerificationRequirements(
  requirements: VerificationIntentRequirementInput[]
): StoredVerificationIntentRequirement[] {
  return hostedVerificationService.normalizeRequirements(requirements);
}

export function mapHostedVerificationIntentResponse(
  intent: HostedVerificationIntentRecord | null,
  frontendBaseUrl: string
) {
  return hostedVerificationService.mapIntentResponse(intent, frontendBaseUrl);
}

export function decorateHostedVerificationRequirement(
  requirement: StoredVerificationIntentRequirement
) {
  return hostedVerificationService.decorateRequirement(requirement);
}

export async function verifyHostedManualLicenseIntent(input: {
  convex: ConvexServerClient;
  apiSecret: string;
  encryptionSecret: string;
  authUserId: string;
  intentId: Id<'verification_intents'>;
  methodKey: string;
  licenseKey: string;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const intent = (await input.convex.query(api.verificationIntents.getIntentRecord, {
    apiSecret: input.apiSecret,
    authUserId: input.authUserId,
    intentId: input.intentId,
  })) as HostedVerificationIntentRecord | null;

  if (!intent) {
    return {
      success: false,
      errorCode: 'not_found',
      errorMessage: 'Verification intent not found',
    };
  }

  if (intent.status !== 'pending') {
    return {
      success: false,
      errorCode: 'invalid_state',
      errorMessage: `Verification intent is ${intent.status}`,
    };
  }

  if (intent.expiresAt <= Date.now()) {
    return {
      success: false,
      errorCode: 'expired',
      errorMessage: 'Verification intent has expired',
    };
  }

  const requirement = intent.requirements.find(
    (entry) => entry.methodKey === input.methodKey && entry.kind === 'manual_license'
  );
  if (!requirement?.providerProductRef) {
    return {
      success: false,
      errorCode: 'invalid_method',
      errorMessage: 'Verification method does not support manual license proof',
    };
  }

  const adapter = getProviderRuntime(requirement.providerKey)?.buyerVerification;
  if (!adapter) {
    return {
      success: false,
      errorCode: 'unsupported_method',
      errorMessage: 'This provider does not support hosted manual license verification yet.',
    };
  }

  const result = await adapter.verify(
    {
      methodKind: 'manual_license',
      packageId: intent.packageId,
      providerProductRef: requirement.providerProductRef,
      licenseKey: input.licenseKey,
    },
    {
      convex: input.convex,
      apiSecret: input.apiSecret,
      encryptionSecret: input.encryptionSecret,
    }
  );

  if (!result.success) {
    const errorCode = result.errorCode ?? 'invalid_proof';
    const errorMessage = sanitizePublicErrorMessage(
      result.errorMessage,
      'License verification failed'
    );

    await input.convex.mutation(internal.verificationIntents.markIntentFailed, {
      intentId: input.intentId,
      errorCode,
      errorMessage,
    });

    return {
      success: false,
      errorCode,
      errorMessage,
    };
  }

  await input.convex.mutation(internal.verificationIntents.markIntentVerified, {
    intentId: input.intentId,
    methodKey: input.methodKey,
  });

  return { success: true };
}

export async function verifyHostedBuyerProviderLinkIntent(input: {
  convex: ConvexServerClient;
  apiSecret: string;
  encryptionSecret: string;
  authUserId: string;
  intentId: Id<'verification_intents'>;
  methodKey: string;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const intent = (await input.convex.query(api.verificationIntents.getIntentRecord, {
    apiSecret: input.apiSecret,
    authUserId: input.authUserId,
    intentId: input.intentId,
  })) as HostedVerificationIntentRecord | null;

  const requirement = intent?.requirements.find(
    (entry) => entry.methodKey === input.methodKey && entry.kind === 'buyer_provider_link'
  );
  const hook = requirement ? getProviderHooks(requirement.providerKey)?.buyerLink : undefined;
  if (hook?.verifyHostedIntent) {
    return await hook.verifyHostedIntent(
      {
        authUserId: input.authUserId,
        intentId: input.intentId,
        methodKey: input.methodKey,
      },
      {
        convex: input.convex,
        apiSecret: input.apiSecret,
        encryptionSecret: input.encryptionSecret,
      }
    );
  }

  return input.convex.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
    apiSecret: input.apiSecret,
    authUserId: input.authUserId,
    intentId: input.intentId,
    methodKey: input.methodKey,
  });
}
