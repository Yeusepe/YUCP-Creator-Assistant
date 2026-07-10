/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountSecurity from "../accountSecurity.js";
import type * as adminNotifications from "../adminNotifications.js";
import type * as attestation from "../attestation.js";
import type * as audit_events from "../audit_events.js";
import type * as auth from "../auth.js";
import type * as authViewer from "../authViewer.js";
import type * as backgroundSync from "../backgroundSync.js";
import type * as backstageRepos from "../backstageRepos.js";
import type * as betterAuthApiKeys from "../betterAuthApiKeys.js";
import type * as bindings from "../bindings.js";
import type * as catalogTiers from "../catalogTiers.js";
import type * as certificateBilling from "../certificateBilling.js";
import type * as certificateBillingSync from "../certificateBillingSync.js";
import type * as collaboratorInvites from "../collaboratorInvites.js";
import type * as couplingForensics from "../couplingForensics.js";
import type * as couplingRuntime from "../couplingRuntime.js";
import type * as couplingRuntimeUpload from "../couplingRuntimeUpload.js";
import type * as creatorEvents from "../creatorEvents.js";
import type * as creatorProfiles from "../creatorProfiles.js";
import type * as crons from "../crons.js";
import type * as dashboardViews from "../dashboardViews.js";
import type * as downloads from "../downloads.js";
import type * as entitlements from "../entitlements.js";
import type * as guildLinks from "../guildLinks.js";
import type * as guildMemberAdd from "../guildMemberAdd.js";
import type * as http from "../http.js";
import type * as identitySync from "../identitySync.js";
import type * as lib_accountSecurityConfig from "../lib/accountSecurityConfig.js";
import type * as lib_accountSecurityEmail from "../lib/accountSecurityEmail.js";
import type * as lib_apiActor from "../lib/apiActor.js";
import type * as lib_apiAuth from "../lib/apiAuth.js";
import type * as lib_authUser from "../lib/authUser.js";
import type * as lib_backstageAliasMetadata from "../lib/backstageAliasMetadata.js";
import type * as lib_betterAuthAdapter from "../lib/betterAuthAdapter.js";
import type * as lib_billingCapabilities from "../lib/billingCapabilities.js";
import type * as lib_canonicalDescriptor from "../lib/canonicalDescriptor.js";
import type * as lib_certificateBillingCatalog from "../lib/certificateBillingCatalog.js";
import type * as lib_certificateBillingConfig from "../lib/certificateBillingConfig.js";
import type * as lib_certificateBillingProjection from "../lib/certificateBillingProjection.js";
import type * as lib_certificateCapabilityProjection from "../lib/certificateCapabilityProjection.js";
import type * as lib_certificateSigning from "../lib/certificateSigning.js";
import type * as lib_couplingRuntimeConfig from "../lib/couplingRuntimeConfig.js";
import type * as lib_couplingRuntimeEnvelope from "../lib/couplingRuntimeEnvelope.js";
import type * as lib_couplingRuntimePackageConfig from "../lib/couplingRuntimePackageConfig.js";
import type * as lib_couplingServiceRuntimeArtifacts from "../lib/couplingServiceRuntimeArtifacts.js";
import type * as lib_credentialKeys from "../lib/credentialKeys.js";
import type * as lib_externalAccountIdentity from "../lib/externalAccountIdentity.js";
import type * as lib_hkdfAesGcm from "../lib/hkdfAesGcm.js";
import type * as lib_httpRateLimit from "../lib/httpRateLimit.js";
import type * as lib_licenseSubjectLink from "../lib/licenseSubjectLink.js";
import type * as lib_logger from "../lib/logger.js";
import type * as lib_ownership from "../lib/ownership.js";
import type * as lib_piiCrypto from "../lib/piiCrypto.js";
import type * as lib_protectedAssetKeyCrypto from "../lib/protectedAssetKeyCrypto.js";
import type * as lib_protectedAssetUnlockMode from "../lib/protectedAssetUnlockMode.js";
import type * as lib_protectedMaterializationGrant from "../lib/protectedMaterializationGrant.js";
import type * as lib_providerLicenseVerification from "../lib/providerLicenseVerification.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_publicAuthIssuer from "../lib/publicAuthIssuer.js";
import type * as lib_publicProducts from "../lib/publicProducts.js";
import type * as lib_recoveryPasskeyCompletion from "../lib/recoveryPasskeyCompletion.js";
import type * as lib_releaseArtifactEnvelope from "../lib/releaseArtifactEnvelope.js";
import type * as lib_releaseArtifactKeys from "../lib/releaseArtifactKeys.js";
import type * as lib_roleRules_catalog from "../lib/roleRules/catalog.js";
import type * as lib_roleRules_discord from "../lib/roleRules/discord.js";
import type * as lib_roleRules_queries from "../lib/roleRules/queries.js";
import type * as lib_roleRules_roleIds from "../lib/roleRules/roleIds.js";
import type * as lib_roleSyncEnqueue from "../lib/roleSyncEnqueue.js";
import type * as lib_roleSyncIdentity from "../lib/roleSyncIdentity.js";
import type * as lib_roleSyncWorkpoolDispatch from "../lib/roleSyncWorkpoolDispatch.js";
import type * as lib_trustedOrigins from "../lib/trustedOrigins.js";
import type * as lib_verifyPrompt from "../lib/verifyPrompt.js";
import type * as lib_vrchat_client from "../lib/vrchat/client.js";
import type * as lib_vrchat_cookie from "../lib/vrchat/cookie.js";
import type * as lib_vrchat_crypto from "../lib/vrchat/crypto.js";
import type * as lib_vrchat_guards from "../lib/vrchat/guards.js";
import type * as lib_vrchat_index from "../lib/vrchat/index.js";
import type * as lib_vrchat_types from "../lib/vrchat/types.js";
import type * as lib_yucpCrypto from "../lib/yucpCrypto.js";
import type * as licenseVerification from "../licenseVerification.js";
import type * as manualLicenses from "../manualLicenses.js";
import type * as migrations from "../migrations.js";
import type * as oauthApps from "../oauthApps.js";
import type * as oauthClients from "../oauthClients.js";
import type * as oauthDiscovery from "../oauthDiscovery.js";
import type * as oauthLoopback from "../oauthLoopback.js";
import type * as outbox_jobs from "../outbox_jobs.js";
import type * as packageRegistry from "../packageRegistry.js";
import type * as plugins_vrchat from "../plugins/vrchat.js";
import type * as polyfills from "../polyfills.js";
import type * as productResolution from "../productResolution.js";
import type * as providerConnections from "../providerConnections.js";
import type * as providerPlatform from "../providerPlatform.js";
import type * as providers_index from "../providers/index.js";
import type * as providers_shared from "../providers/shared.js";
import type * as purgeOrphans from "../purgeOrphans.js";
import type * as releaseArtifacts from "../releaseArtifacts.js";
import type * as roleSyncActions from "../roleSyncActions.js";
import type * as roleSyncOnComplete from "../roleSyncOnComplete.js";
import type * as roleSyncWorkpool from "../roleSyncWorkpool.js";
import type * as role_rules from "../role_rules.js";
import type * as seedYucpOAuthClient from "../seedYucpOAuthClient.js";
import type * as setupJobs from "../setupJobs.js";
import type * as signingLog from "../signingLog.js";
import type * as subjects from "../subjects.js";
import type * as tenantHelpers from "../tenantHelpers.js";
import type * as testHelpers from "../testHelpers.js";
import type * as testHelpersReal from "../testHelpersReal.js";
import type * as userPortal from "../userPortal.js";
import type * as verificationIntents from "../verificationIntents.js";
import type * as verificationSessions from "../verificationSessions.js";
import type * as webhookCron from "../webhookCron.js";
import type * as webhookDeliveries from "../webhookDeliveries.js";
import type * as webhookDeliveryCron from "../webhookDeliveryCron.js";
import type * as webhookDeliveryWorker from "../webhookDeliveryWorker.js";
import type * as webhookIngestion from "../webhookIngestion.js";
import type * as webhookProcessing from "../webhookProcessing.js";
import type * as webhookSubscriptions from "../webhookSubscriptions.js";
import type * as webhooks__helpers from "../webhooks/_helpers.js";
import type * as webhooks_gumroad from "../webhooks/gumroad.js";
import type * as webhooks_jinxxy from "../webhooks/jinxxy.js";
import type * as webhooks_lemonsqueezy from "../webhooks/lemonsqueezy.js";
import type * as webhooks_payhip from "../webhooks/payhip.js";
import type * as yucpCertificates from "../yucpCertificates.js";
import type * as yucpLicenses from "../yucpLicenses.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountSecurity: typeof accountSecurity;
  adminNotifications: typeof adminNotifications;
  attestation: typeof attestation;
  audit_events: typeof audit_events;
  auth: typeof auth;
  authViewer: typeof authViewer;
  backgroundSync: typeof backgroundSync;
  backstageRepos: typeof backstageRepos;
  betterAuthApiKeys: typeof betterAuthApiKeys;
  bindings: typeof bindings;
  catalogTiers: typeof catalogTiers;
  certificateBilling: typeof certificateBilling;
  certificateBillingSync: typeof certificateBillingSync;
  collaboratorInvites: typeof collaboratorInvites;
  couplingForensics: typeof couplingForensics;
  couplingRuntime: typeof couplingRuntime;
  couplingRuntimeUpload: typeof couplingRuntimeUpload;
  creatorEvents: typeof creatorEvents;
  creatorProfiles: typeof creatorProfiles;
  crons: typeof crons;
  dashboardViews: typeof dashboardViews;
  downloads: typeof downloads;
  entitlements: typeof entitlements;
  guildLinks: typeof guildLinks;
  guildMemberAdd: typeof guildMemberAdd;
  http: typeof http;
  identitySync: typeof identitySync;
  "lib/accountSecurityConfig": typeof lib_accountSecurityConfig;
  "lib/accountSecurityEmail": typeof lib_accountSecurityEmail;
  "lib/apiActor": typeof lib_apiActor;
  "lib/apiAuth": typeof lib_apiAuth;
  "lib/authUser": typeof lib_authUser;
  "lib/backstageAliasMetadata": typeof lib_backstageAliasMetadata;
  "lib/betterAuthAdapter": typeof lib_betterAuthAdapter;
  "lib/billingCapabilities": typeof lib_billingCapabilities;
  "lib/canonicalDescriptor": typeof lib_canonicalDescriptor;
  "lib/certificateBillingCatalog": typeof lib_certificateBillingCatalog;
  "lib/certificateBillingConfig": typeof lib_certificateBillingConfig;
  "lib/certificateBillingProjection": typeof lib_certificateBillingProjection;
  "lib/certificateCapabilityProjection": typeof lib_certificateCapabilityProjection;
  "lib/certificateSigning": typeof lib_certificateSigning;
  "lib/couplingRuntimeConfig": typeof lib_couplingRuntimeConfig;
  "lib/couplingRuntimeEnvelope": typeof lib_couplingRuntimeEnvelope;
  "lib/couplingRuntimePackageConfig": typeof lib_couplingRuntimePackageConfig;
  "lib/couplingServiceRuntimeArtifacts": typeof lib_couplingServiceRuntimeArtifacts;
  "lib/credentialKeys": typeof lib_credentialKeys;
  "lib/externalAccountIdentity": typeof lib_externalAccountIdentity;
  "lib/hkdfAesGcm": typeof lib_hkdfAesGcm;
  "lib/httpRateLimit": typeof lib_httpRateLimit;
  "lib/licenseSubjectLink": typeof lib_licenseSubjectLink;
  "lib/logger": typeof lib_logger;
  "lib/ownership": typeof lib_ownership;
  "lib/piiCrypto": typeof lib_piiCrypto;
  "lib/protectedAssetKeyCrypto": typeof lib_protectedAssetKeyCrypto;
  "lib/protectedAssetUnlockMode": typeof lib_protectedAssetUnlockMode;
  "lib/protectedMaterializationGrant": typeof lib_protectedMaterializationGrant;
  "lib/providerLicenseVerification": typeof lib_providerLicenseVerification;
  "lib/providers": typeof lib_providers;
  "lib/publicAuthIssuer": typeof lib_publicAuthIssuer;
  "lib/publicProducts": typeof lib_publicProducts;
  "lib/recoveryPasskeyCompletion": typeof lib_recoveryPasskeyCompletion;
  "lib/releaseArtifactEnvelope": typeof lib_releaseArtifactEnvelope;
  "lib/releaseArtifactKeys": typeof lib_releaseArtifactKeys;
  "lib/roleRules/catalog": typeof lib_roleRules_catalog;
  "lib/roleRules/discord": typeof lib_roleRules_discord;
  "lib/roleRules/queries": typeof lib_roleRules_queries;
  "lib/roleRules/roleIds": typeof lib_roleRules_roleIds;
  "lib/roleSyncEnqueue": typeof lib_roleSyncEnqueue;
  "lib/roleSyncIdentity": typeof lib_roleSyncIdentity;
  "lib/roleSyncWorkpoolDispatch": typeof lib_roleSyncWorkpoolDispatch;
  "lib/trustedOrigins": typeof lib_trustedOrigins;
  "lib/verifyPrompt": typeof lib_verifyPrompt;
  "lib/vrchat/client": typeof lib_vrchat_client;
  "lib/vrchat/cookie": typeof lib_vrchat_cookie;
  "lib/vrchat/crypto": typeof lib_vrchat_crypto;
  "lib/vrchat/guards": typeof lib_vrchat_guards;
  "lib/vrchat/index": typeof lib_vrchat_index;
  "lib/vrchat/types": typeof lib_vrchat_types;
  "lib/yucpCrypto": typeof lib_yucpCrypto;
  licenseVerification: typeof licenseVerification;
  manualLicenses: typeof manualLicenses;
  migrations: typeof migrations;
  oauthApps: typeof oauthApps;
  oauthClients: typeof oauthClients;
  oauthDiscovery: typeof oauthDiscovery;
  oauthLoopback: typeof oauthLoopback;
  outbox_jobs: typeof outbox_jobs;
  packageRegistry: typeof packageRegistry;
  "plugins/vrchat": typeof plugins_vrchat;
  polyfills: typeof polyfills;
  productResolution: typeof productResolution;
  providerConnections: typeof providerConnections;
  providerPlatform: typeof providerPlatform;
  "providers/index": typeof providers_index;
  "providers/shared": typeof providers_shared;
  purgeOrphans: typeof purgeOrphans;
  releaseArtifacts: typeof releaseArtifacts;
  roleSyncActions: typeof roleSyncActions;
  roleSyncOnComplete: typeof roleSyncOnComplete;
  roleSyncWorkpool: typeof roleSyncWorkpool;
  role_rules: typeof role_rules;
  seedYucpOAuthClient: typeof seedYucpOAuthClient;
  setupJobs: typeof setupJobs;
  signingLog: typeof signingLog;
  subjects: typeof subjects;
  tenantHelpers: typeof tenantHelpers;
  testHelpers: typeof testHelpers;
  testHelpersReal: typeof testHelpersReal;
  userPortal: typeof userPortal;
  verificationIntents: typeof verificationIntents;
  verificationSessions: typeof verificationSessions;
  webhookCron: typeof webhookCron;
  webhookDeliveries: typeof webhookDeliveries;
  webhookDeliveryCron: typeof webhookDeliveryCron;
  webhookDeliveryWorker: typeof webhookDeliveryWorker;
  webhookIngestion: typeof webhookIngestion;
  webhookProcessing: typeof webhookProcessing;
  webhookSubscriptions: typeof webhookSubscriptions;
  "webhooks/_helpers": typeof webhooks__helpers;
  "webhooks/gumroad": typeof webhooks_gumroad;
  "webhooks/jinxxy": typeof webhooks_jinxxy;
  "webhooks/lemonsqueezy": typeof webhooks_lemonsqueezy;
  "webhooks/payhip": typeof webhooks_payhip;
  yucpCertificates: typeof yucpCertificates;
  yucpLicenses: typeof yucpLicenses;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  roleSyncPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"roleSyncPool">;
};
