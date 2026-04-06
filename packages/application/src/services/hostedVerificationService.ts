import type {
  HostedVerificationIntentRecord,
  HostedVerificationManualCapabilityDescriptor,
  HostedVerificationProviderPort,
  StoredVerificationIntentRequirement,
  VerificationIntentRequirementInput,
  VerificationIntentRequirementKind,
  VerificationIntentRequirementResponse,
} from '../ports/hostedVerification';

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
  | HostedVerificationManualCapabilityDescriptor;

const INTERNAL_ENTITLEMENT_PROVIDER_KEY = 'yucp';
const INTERNAL_ENTITLEMENT_PROVIDER_LABEL = 'YUCP';

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface HostedVerificationServiceOptions {
  readonly providers: HostedVerificationProviderPort;
}

export class HostedVerificationService {
  constructor(private readonly options: HostedVerificationServiceOptions) {}

  normalizeRequirements(
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

      const capability = this.describeHostedVerificationCapability(providerKey, kind);
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

  buildVerificationUrl(frontendBaseUrl: string, intentId: string): string {
    const base = frontendBaseUrl.replace(/\/$/, '');
    return `${base}/verify/purchase?intent=${encodeURIComponent(intentId)}`;
  }

  decorateRequirement(
    requirement: StoredVerificationIntentRequirement
  ): VerificationIntentRequirementResponse {
    const providerLabel = this.getHostedProviderLabel(requirement.providerKey);
    const capability = this.describeHostedVerificationCapability(
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

  mapIntentResponse(intent: HostedVerificationIntentRecord | null, frontendBaseUrl: string) {
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
      verificationUrl: this.buildVerificationUrl(frontendBaseUrl, String(intent._id)),
      returnUrl: intent.returnUrl,
      requirements: intent.requirements.map((requirement) => this.decorateRequirement(requirement)),
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

  private getHostedProviderLabel(providerKey: string): string {
    if (providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY) {
      return INTERNAL_ENTITLEMENT_PROVIDER_LABEL;
    }

    return this.options.providers.getProvider(providerKey)?.label ?? providerKey;
  }

  private createExistingEntitlementCapability(
    providerKey: string
  ): ExistingEntitlementCapabilityDescriptor {
    const providerLabel =
      providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY
        ? INTERNAL_ENTITLEMENT_PROVIDER_LABEL
        : this.getHostedProviderLabel(providerKey);

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

  private createBuyerProviderLinkCapability(
    providerKey: string
  ): BuyerProviderLinkCapabilityDescriptor {
    const providerLabel = this.getHostedProviderLabel(providerKey);

    return {
      methodKind: 'buyer_provider_link',
      completion: 'immediate',
      actionLabel: 'Use linked account',
      defaultTitle: `${providerLabel} account`,
      defaultDescription: `Use the ${providerLabel} account already linked to this buyer.`,
    };
  }

  private describeHostedVerificationCapability(
    providerKey: string,
    kind: VerificationIntentRequirementKind
  ): HostedVerificationCapabilityDescriptor {
    if (kind === 'existing_entitlement') {
      if (providerKey === INTERNAL_ENTITLEMENT_PROVIDER_KEY) {
        return this.createExistingEntitlementCapability(providerKey);
      }

      const provider = this.options.providers.getProvider(providerKey);
      if (!provider) {
        throw new Error(`Provider '${providerKey}' is not registered`);
      }
      if (!provider.buyerVerificationMethods.includes('account_link')) {
        throw new Error(
          `Provider '${providerKey}' does not support hosted entitlement verification`
        );
      }
      return this.createExistingEntitlementCapability(providerKey);
    }

    if (kind === 'buyer_provider_link') {
      const provider = this.options.providers.getProvider(providerKey);
      if (!provider) {
        throw new Error(`Provider '${providerKey}' is not registered`);
      }
      if (!provider.buyerVerificationMethods.includes('account_link')) {
        throw new Error(`Provider '${providerKey}' does not support buyer account linking`);
      }
      if (!provider.supportsHostedBuyerAccountLink) {
        throw new Error(
          `Provider '${providerKey}' does not support buyer account linking in the hosted flow`
        );
      }
      return this.createBuyerProviderLinkCapability(providerKey);
    }

    const capability =
      this.options.providers.getProvider(providerKey)?.describeManualLicenseCapability() ?? null;
    if (!capability) {
      throw new Error(
        `Provider '${providerKey}' does not support hosted manual license verification`
      );
    }
    return capability;
  }
}
