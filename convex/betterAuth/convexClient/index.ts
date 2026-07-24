/**
 * Convex database bridge for Better Auth 1.7.
 *
 * Adapted from:
 * https://github.com/get-convex/better-auth/tree/v0.12.5/src/client
 *
 * The upstream source is licensed under Apache-2.0.
 */
import { convexAdapter } from "./adapter.js";
import { createClient } from "./createClient.js";
import type { AuthFunctions, Triggers } from "./createClient.js";
import { createApi } from "./createApi.js";
import type { CreateAuth, EventFunction, GenericCtx } from "./utils.js";

export {
  convexAdapter,
  createClient,
  createApi,
  type CreateAuth,
  type EventFunction,
  type GenericCtx,
  type Triggers,
  type AuthFunctions,
};
