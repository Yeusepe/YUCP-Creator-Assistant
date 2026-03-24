import { getProviderDescriptor } from '@yucp/shared';
import { api, internal } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexServerClient } from '../lib/convex';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProvider } from '../providers';
import type { BuyerVerificationCapabilityDescriptor } from '../providers/types';
import { getVerificationConfig } from './sessionManager';

const INTERNAL_ENTITLEMENT_PROVIDER_KEY = 'yucp';
const INTERNAL_ENTITLEMENT_PROVIDER_LABEL = 'YUCP';

export interface VerificationIntentRequirementInput {
  methodKey?: string;
  providerKey?: string;
  kind?: 'existing_entitlement' | 'manual_license' | 'buyer_provider_link';
  title?: string;
  description?: string;
  creatorAuthUserId?: string;
  productId?: string;
  providerProductRef?: string;
}

export interface StoredVerificationIntentRequirement {
  methodKey: string;
  providerKey: string;
  kind: 'existing_entitlement' | 'manual_license' | 'buyer_provider_link';
  title: string;
  description?: string;
  creatorAuthUserId?: string;
  productId?: string;
  providerProductRef?: string;
}

export interface VerificationIntentRequirementCapabilityInput {
  kind: 'license_key';
  label: string;
  placeholder?: string;
  masked: boolean;
  submitLabel: string;
}

export interface VerificationIntentRequirementCapability {
  methodKind: 'existing_entitlement' | 'manual_license' | 'buyer_provider_link';
  completion: 'immediate' | 'deferred';
  actionLabel: string;
  input?: VerificationIntentRequirementCapabilityInput;
}

export interface VerificationIntentRequirementResponse extends StoredVerificationIntentRequirement {
  providerLabel: string;
  capability: VerificationIntentRequirementCapability;
}

interface ExistingEntitlementCapabilityDescriptor {
  methodKind: 'existing_entitlement';
  completion: 'immediate';
  actionLabel: string;
  defaultTitle: string;
  defaultDescription?: string;
}

interface BuyerProviderLinkCapabilityDescriptor {
  methodKind: 'buyer_provider_link';
  completion: 'immediate';
  actionLabel: string;
  defaultTitle: string;
  defaultDescription?: string;
}

type HostedVerificationCapabilityDescriptor =
  | ExistingEntitlementCapabilityDescriptor
  | BuyerProviderLinkCapabilityDescriptor
  | BuyerVerificationCapabilityDescriptor;

export interface HostedVerificationIntentRecord {
  _id: string;
  authUserId: string;
  packageId: string;
  packageName?: string;
  returnUrl: string;
  requirements: StoredVerificationIntentRequirement[];
  status: string;
  verifiedMethodKey?: string;
  errorCode?: string;
  errorMessage?: string;
  grantToken?: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function createExistingEntitlementCapability(
  providerKey: string
): ExistingEntitlementCapabilityDescriptor {
  const providerLabel =
    providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY
      ? INTERNAL_ENTITLEMENT_PROVIDER_LABEL
      : (getProviderDescriptor(providerKey)?.label ?? providerKey);

  return {
    methodKind: 'existing_entitlement',
    completion: 'immediate',
    actionLabel: 'Check access',
    defaultTitle:
      providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY
        ? 'Connected YUCP access'
        : `${providerLabel} access`,
    defaultDescription:
      providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY
        ? 'Check whether your signed-in YUCP buyer account already has access to this package.'
        : `Check whether your linked ${providerLabel} access already grants this package.`,
  };
}

function createBuyerProviderLinkCapability(
  providerKey: string
): BuyerProviderLinkCapabilityDescriptor {
  const descriptor = getProviderDescriptor(providerKey);
  const providerLabel = descriptor?.label ?? providerKey;

  return {
    methodKind: 'buyer_provider_link',
    completion: 'immediate',
    actionLabel: 'Use linked account',
    defaultTitle: `${providerLabel} account`,
    defaultDescription: `Use the ${providerLabel} account already linked to this buyer.`,
  };
}

function supportsHostedBuyerAccountLink(providerKey: string): boolean {
  const provider = getProvider(providerKey);
  return Boolean(provider?.displayMeta?.userSetupPath || getVerificationConfig(providerKey));
}

function getHostedProviderLabel(providerKey: string): string {
  if (providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY) {
    return INTERNAL_ENTITLEMENT_PROVIDER_LABEL;
  }
  return getProviderDescriptor(providerKey)?.label ?? providerKey;
}

function describeHostedVerificationCapability(
  providerKey: string,
  kind: StoredVerificationIntentRequirement['kind']
): HostedVerificationCapabilityDescriptor {
  if (kind === 'existing_entitlement') {
    if (providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY) {
      return createExistingEntitlementCapability(providerKey);
    }
    const descriptor = getProviderDescriptor(providerKey);
    if (!descriptor) {
      throw new Error(`Provider '${providerKey}' is not registered`);
    }
    if (!descriptor.buyerVerificationMethods.includes('account_link')) {
      throw new Error(`Provider '${providerKey}' does not support hosted entitlement verification`);
    }
    return createExistingEntitlementCapability(providerKey);
  }

  if (kind === 'buyer_provider_link') {
    const descriptor = getProviderDescriptor(providerKey);
    if (!descriptor) {
      throw new Error(`Provider '${providerKey}' is not registered`);
    }
    if (!descriptor.buyerVerificationMethods.includes('account_link')) {
      throw new Error(`Provider '${providerKey}' does not support buyer account linking`);
    }
    if (!supportsHostedBuyerAccountLink(providerKey)) {
      throw new Error(
        `Provider '${providerKey}' does not support buyer account linking in the hosted flow`
      );
    }
    return createBuyerProviderLinkCapability(providerKey);
  }

  const capability =
    getProvider(providerKey)?.buyerVerification?.describeCapability('manual_license');
  if (!capability) {
    throw new Error(
      `Provider '${providerKey}' does not support hosted manual license verification`
    );
  }
  return capability;
}

export function normalizeHostedVerificationRequirements(
  requirements: VerificationIntentRequirementInput[]
): StoredVerificationIntentRequirement[] {
  return requirements.map((requirement) => {
    const methodKey = trimToUndefined(requirement.methodKey);
    const providerKey = trimToUndefined(requirement.providerKey);
    const kind = requirement.kind;

    if (!methodKey || !providerKey || !kind) {
      throw new Error(
        'Each verification requirement must include methodKey, providerKey, and kind'
      );
    }

    const capability = describeHostedVerificationCapability(providerKey, kind);
    const title = trimToUndefined(requirement.title) ?? capability.defaultTitle;
    const description = trimToUndefined(requirement.description) ?? capability.defaultDescription;
    const creatorAuthUserId = trimToUndefined(requirement.creatorAuthUserId);
    const productId = trimToUndefined(requirement.productId);
    const providerProductRef = trimToUndefined(requirement.providerProductRef);

    if (kind === 'existing_entitlement' && (!creatorAuthUserId || !productId)) {
      throw new Error(
        `existing_entitlement method '${methodKey}' requires creatorAuthUserId and productId`
      );
    }

    if (kind === 'manual_license' && !providerProductRef) {
      throw new Error(`manual_license method '${methodKey}' requires providerProductRef`);
    }

    return {
      methodKey,
      providerKey,
      kind,
      title,
      description,
      creatorAuthUserId,
      productId,
      providerProductRef,
    };
  });
}

export function buildVerificationUrl(frontendBaseUrl: string, intentId: string): string {
  const base = frontendBaseUrl.replace(/\/$/, '');
  return `${base}/verify/purchase?intent=${encodeURIComponent(intentId)}`;
}

export function decorateHostedVerificationRequirement(
  requirement: StoredVerificationIntentRequirement
): VerificationIntentRequirementResponse {
  const providerLabel = getHostedProviderLabel(requirement.providerKey);
  const capability = describeHostedVerificationCapability(
    requirement.providerKey,
    requirement.kind
  );

  return {
    ...requirement,
    providerLabel,
    capability: {
      methodKind: capability.methodKind,
      completion: capability.completion,
      actionLabel: capability.actionLabel,
      input:
        'input' in capability
          ? {
              kind: capability.input.kind,
              label: capability.input.label,
              placeholder: capability.input.placeholder,
              masked: capability.input.masked,
              submitLabel: capability.input.submitLabel,
            }
          : undefined,
    },
  };
}

export function mapHostedVerificationIntentResponse(
  intent: HostedVerificationIntentRecord | null,
  frontendBaseUrl: string
) {
  if (!intent) {
    return null;
  }

  return {
    object: 'verification_intent' as const,
    id: intent._id,
    authUserId: intent.authUserId,
    packageId: intent.packageId,
    packageName: intent.packageName ?? null,
    status: intent.status,
    verificationUrl: buildVerificationUrl(frontendBaseUrl, String(intent._id)),
    returnUrl: intent.returnUrl,
    requirements: intent.requirements.map(decorateHostedVerificationRequirement),
    verifiedMethodKey: intent.verifiedMethodKey ?? null,
    errorCode: intent.errorCode ?? null,
    errorMessage: intent.errorMessage ?? null,
    grantToken: intent.grantToken ?? null,
    grantAvailable: Boolean(intent.grantToken),
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
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

  const adapter = getProvider(requirement.providerKey)?.buyerVerification;
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
  authUserId: string;
  intentId: Id<'verification_intents'>;
  methodKey: string;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  return input.convex.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
    apiSecret: input.apiSecret,
    authUserId: input.authUserId,
    intentId: input.intentId,
    methodKey: input.methodKey,
  });
}
