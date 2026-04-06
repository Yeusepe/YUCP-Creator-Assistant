export type VerificationIntentRequirementKind =
  | 'existing_entitlement'
  | 'manual_license'
  | 'buyer_provider_link';

export interface VerificationIntentRequirementInput {
  methodKey?: string;
  providerKey?: string;
  kind?: VerificationIntentRequirementKind;
  title?: string;
  description?: string;
  creatorAuthUserId?: string;
  productId?: string;
  providerProductRef?: string;
}

export interface StoredVerificationIntentRequirement {
  methodKey: string;
  providerKey: string;
  kind: VerificationIntentRequirementKind;
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
  methodKind: VerificationIntentRequirementKind;
  completion: 'immediate' | 'deferred';
  actionLabel: string;
  input?: VerificationIntentRequirementCapabilityInput;
}

export interface VerificationIntentRequirementResponse extends StoredVerificationIntentRequirement {
  providerLabel: string;
  capability: VerificationIntentRequirementCapability;
}

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

export interface HostedVerificationCapabilityInput {
  kind: 'license_key';
  label: string;
  placeholder?: string;
  masked: boolean;
  submitLabel: string;
}

export interface HostedVerificationManualCapabilityDescriptor {
  methodKind: 'manual_license';
  completion: 'immediate' | 'deferred';
  actionLabel: string;
  defaultTitle: string;
  defaultDescription?: string;
  input: HostedVerificationCapabilityInput;
}

export interface HostedVerificationProviderDescriptor {
  label: string;
  buyerVerificationMethods: readonly string[];
  supportsHostedBuyerAccountLink: boolean;
  describeManualLicenseCapability(): HostedVerificationManualCapabilityDescriptor | null;
}

export interface HostedVerificationProviderPort {
  getProvider(providerKey: string): HostedVerificationProviderDescriptor | undefined;
}
