// Public provider library surface for concrete provider clients and shared helpers.

export type { LicenseFormat } from './core/licenseFormat';
export { detectLicenseFormat } from './core/licenseFormat';
export type { ProviderMeta } from './core/meta';
export { LICENSE_PROVIDERS, PROVIDER_META, providerLabel } from './core/meta';
export * from './discord';
export type {
  AuthorizationUrlResult,
  EncryptionService,
  GumroadAdapterConfig,
  GumroadProduct,
  GumroadPurchaseEvidence,
  GumroadSale,
  OAuthCompletionResult,
  StateStorage,
  TokenStorage,
} from './gumroad';
// Re-export Gumroad adapter (full implementation in ./gumroad)
export { GumroadAdapter, resolveGumroadProduct, resolveGumroadProductId } from './gumroad';
export type {
  JinxxyAdapterConfig,
  JinxxyApiError,
  JinxxyCustomer,
  JinxxyEvidence,
  JinxxyLicense,
  JinxxyOrder,
  JinxxyPagination,
  JinxxyProduct,
  JinxxyRateLimitError,
  LicenseVerificationResult,
  PurchaseVerificationResult,
} from './jinxxy';
export { JinxxyAdapter, JinxxyApiClient } from './jinxxy';
export type {
  LemonSqueezyAdapterConfig,
  LemonSqueezyEvidence,
  LemonSqueezyLicenseKey,
  LemonSqueezyLicenseValidationResult,
  LemonSqueezyOrder,
  LemonSqueezyStore,
  LemonSqueezySubscription,
  LemonSqueezyVariant,
  LemonSqueezyWebhook,
  LemonSqueezyWebhookCreateInput,
} from './lemonsqueezy';
export {
  LemonSqueezyAdapter,
  LemonSqueezyApiClient,
  LemonSqueezyApiError,
  LemonSqueezyRateLimitError,
} from './lemonsqueezy';
export * from './manual';
export type {
  PayhipAdapterConfig,
  PayhipEvidence,
  PayhipLicenseVerifyData,
  PayhipLicenseVerifyResponse,
  PayhipLicenseVerifyResult,
  PayhipPaidPayload,
  PayhipProductKey,
  PayhipRefundedPayload,
  PayhipWebhookItem,
  PayhipWebhookPayload,
} from './payhip';
export {
  PayhipAdapter,
  PayhipApiClient,
  PayhipApiError,
  PayhipRateLimitError,
  resolvePayhipProduct,
} from './payhip';
export type {
  RequiresTwoFactorAuth,
  TwoFactorAuthType,
  VrchatCurrentUser,
  VrchatLicensedAvatar,
  VrchatVerifyOwnershipResult,
} from './vrchat';
export { extractVrchatAvatarId, VrchatApiClient } from './vrchat';
