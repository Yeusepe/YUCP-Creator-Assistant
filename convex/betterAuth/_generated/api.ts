/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountIdentityMigration from "../accountIdentityMigration.js";
import type * as adapter from "../adapter.js";
import type * as auth from "../auth.js";
import type * as convexClient_adapter from "../convexClient/adapter.js";
import type * as convexClient_adapterUtils from "../convexClient/adapterUtils.js";
import type * as convexClient_createApi from "../convexClient/createApi.js";
import type * as convexClient_createClient from "../convexClient/createClient.js";
import type * as convexClient_createSchema from "../convexClient/createSchema.js";
import type * as convexClient_index from "../convexClient/index.js";
import type * as convexClient_utils from "../convexClient/utils.js";
import type * as convexPlugin from "../convexPlugin.js";
import type * as jwks from "../jwks.js";
import type * as jwtAdapter from "../jwtAdapter.js";
import type * as oauthProviderScopes from "../oauthProviderScopes.js";
import type * as options from "../options.js";
import type * as v17Migration from "../v17Migration.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  accountIdentityMigration: typeof accountIdentityMigration;
  adapter: typeof adapter;
  auth: typeof auth;
  "convexClient/adapter": typeof convexClient_adapter;
  "convexClient/adapterUtils": typeof convexClient_adapterUtils;
  "convexClient/createApi": typeof convexClient_createApi;
  "convexClient/createClient": typeof convexClient_createClient;
  "convexClient/createSchema": typeof convexClient_createSchema;
  "convexClient/index": typeof convexClient_index;
  "convexClient/utils": typeof convexClient_utils;
  convexPlugin: typeof convexPlugin;
  jwks: typeof jwks;
  jwtAdapter: typeof jwtAdapter;
  oauthProviderScopes: typeof oauthProviderScopes;
  options: typeof options;
  v17Migration: typeof v17Migration;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
