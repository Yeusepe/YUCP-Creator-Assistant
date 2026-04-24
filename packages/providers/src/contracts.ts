export interface ProviderRuntimeClient {
  query<QueryRef, Args, Result>(reference: QueryRef, args: Args): Promise<Result>;
  mutation<MutationRef, Args, Result>(reference: MutationRef, args: Args): Promise<Result>;
}

export interface ProviderContext<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  convex: TClient;
  apiSecret: string;
  authUserId: string;
  encryptionSecret: string;
}

export interface ProductRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface ProviderTierRecord {
  id: string;
  productId: string;
  name: string;
  description?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProviderTierEntitlementRecord {
  subjectId: string;
  productId: string;
  tierIds: string[];
  status?: string;
  observedAt: string;
  rawRef: string;
  metadata?: Record<string, unknown>;
}

export interface BackfillPage<TFact = unknown> {
  readonly facts: TFact[];
  readonly nextCursor: string | null;
}

export interface BackfillPlugin<TFact = unknown> {
  readonly pageDelayMs: number;
  fetchPage(
    credential: string,
    productRef: string,
    cursor: string | null,
    pageSize: number,
    encryptionSecret: string
  ): Promise<BackfillPage<TFact>>;
}

export interface ProviderPurposes {
  readonly credential: string;
  readonly [key: string]: string;
}

export interface DisconnectContext {
  credentials: Record<string, string>;
  encryptionSecret: string;
  apiBaseUrl: string;
  remoteWebhookId?: string;
}

export interface LicenseVerificationResult {
  valid: boolean;
  externalOrderId?: string;
  providerUserId?: string;
  providerProductId?: string;
  error?: string;
}

export interface LicenseVerificationPlugin<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  verifyLicense(
    licenseKey: string,
    productId: string | undefined,
    authUserId: string,
    ctx: ProviderContext<TClient>
  ): Promise<LicenseVerificationResult | null>;
}

export interface ProviderTierPlugin<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  listProductTiers(
    credential: string | null,
    productId: string,
    ctx: ProviderContext<TClient>
  ): Promise<ProviderTierRecord[]>;
  listEntitlements?(
    credential: string,
    cursor: string | null,
    ctx: ProviderContext<TClient>
  ): Promise<BackfillPage<ProviderTierEntitlementRecord>>;
}

export type BuyerVerificationMethodKind = 'manual_license';

export interface BuyerVerificationCapabilityInput {
  kind: 'license_key';
  label: string;
  placeholder?: string;
  masked: boolean;
  submitLabel: string;
}

export interface BuyerVerificationCapabilityDescriptor {
  methodKind: BuyerVerificationMethodKind;
  completion: 'immediate' | 'deferred';
  actionLabel: string;
  defaultTitle: string;
  defaultDescription?: string;
  input: BuyerVerificationCapabilityInput;
}

export interface BuyerVerificationResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface BuyerVerificationContext<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  convex: TClient;
  apiSecret: string;
  encryptionSecret: string;
}

export interface BuyerVerificationSubmission {
  methodKind: BuyerVerificationMethodKind;
  packageId: string;
  providerProductRef: string;
  licenseKey: string;
}

export interface BuyerVerificationAdapter<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  readonly providerId: string;
  describeCapability(
    methodKind: BuyerVerificationMethodKind
  ): BuyerVerificationCapabilityDescriptor | null;
  verify(
    input: BuyerVerificationSubmission,
    ctx: BuyerVerificationContext<TClient>
  ): Promise<BuyerVerificationResult>;
}

export interface ConnectDisplayMeta {
  readonly dashboardSetupExperience: 'automatic' | 'guided' | 'manual';
  readonly dashboardSetupHint: string;
  readonly label: string;
  readonly icon: string;
  readonly color: string;
  readonly shadowColor: string;
  readonly textColor: string;
  readonly connectedColor: string;
  readonly confettiColors: readonly string[];
  readonly description: string;
  readonly dashboardConnectPath: string;
  readonly userSetupPath?: string;
  readonly dashboardConnectParamStyle: 'camelCase' | 'snakeCase';
  readonly dashboardIconBg: string;
  readonly dashboardQuickStartBg: string;
  readonly dashboardQuickStartBorder: string;
  readonly dashboardServerTileHint: string;
}

export interface ProviderRuntimeModule<
  TBackfillFact = unknown,
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  readonly id: string;
  readonly purposes: ProviderPurposes;
  readonly needsCredential: boolean;
  getCredential(ctx: ProviderContext<TClient>): Promise<string | null>;
  fetchProducts(credential: string | null, ctx: ProviderContext<TClient>): Promise<ProductRecord[]>;
  readonly tiers?: ProviderTierPlugin<TClient>;
  readonly backfill?: BackfillPlugin<TBackfillFact>;
  readonly verification?: LicenseVerificationPlugin<TClient>;
  readonly buyerVerification?: BuyerVerificationAdapter<TClient>;
  readonly supportsCollab?: boolean;
  readonly productCredentialPurpose?: string;
  readonly displayMeta?: ConnectDisplayMeta;
  resolveProductName?(
    credential: string | null,
    urlOrId: string,
    ctx: ProviderContext<TClient>
  ): Promise<{ name: string; error?: string }>;
  onProductCredentialAdded?(productId: string, ctx: ProviderContext<TClient>): Promise<void>;
  collabValidate?(credential: string): Promise<void>;
  readonly collabCredentialPurpose?: string;
}

export class CredentialExpiredError extends Error {
  constructor(public readonly provider: string) {
    super(`Credential expired for provider: ${provider}`);
    this.name = 'CredentialExpiredError';
  }
}
