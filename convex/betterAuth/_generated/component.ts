/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    adapter: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                data: {
                  createdAt: number;
                  email: string;
                  emailVerified: boolean;
                  image?: null | string;
                  name: string;
                  updatedAt: number;
                  userId?: null | string;
                };
                model: "user";
              }
            | {
                data: {
                  createdAt: number;
                  expiresAt: number;
                  ipAddress?: null | string;
                  token: string;
                  updatedAt: number;
                  userAgent?: null | string;
                  userId: string;
                };
                model: "session";
              }
            | {
                data: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId: string;
                  createdAt: number;
                  idToken?: null | string;
                  password?: null | string;
                  providerId: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt: number;
                  userId: string;
                };
                model: "account";
              }
            | {
                data: {
                  createdAt: number;
                  expiresAt: number;
                  identifier: string;
                  updatedAt: number;
                  value: string;
                };
                model: "verification";
              }
            | {
                data: {
                  createdAt: number;
                  expiresAt?: null | number;
                  privateKey: string;
                  publicKey: string;
                };
                model: "jwks";
              }
            | {
                data: {
                  configId?: null | string;
                  createdAt: number;
                  enabled?: null | boolean;
                  expiresAt?: null | number;
                  key: string;
                  lastRefillAt?: null | number;
                  lastRequest?: null | number;
                  metadata?: null | string;
                  name?: null | string;
                  permissions?: null | string;
                  prefix?: null | string;
                  rateLimitEnabled?: null | boolean;
                  rateLimitMax?: null | number;
                  rateLimitTimeWindow?: null | number;
                  referenceId?: null | string;
                  refillAmount?: null | number;
                  refillInterval?: null | number;
                  remaining?: null | number;
                  requestCount?: null | number;
                  start?: null | string;
                  updatedAt: number;
                  userId: string;
                };
                model: "apikey";
              }
            | {
                data: {
                  clientId: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  public?: null | boolean;
                  redirectUris: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  type?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                model: "oauthClient";
              }
            | {
                data: {
                  authTime?: null | number;
                  clientId: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  revoked?: null | number;
                  scopes: Array<string>;
                  sessionId?: null | string;
                  token: string;
                  userId: string;
                };
                model: "oauthRefreshToken";
              }
            | {
                data: {
                  clientId: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  scopes: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                model: "oauthAccessToken";
              }
            | {
                data: {
                  clientId: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  scopes: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                model: "oauthConsent";
              };
          onCreateHandle?: string;
          select?: Array<string>;
        },
        any,
        Name
      >;
      deleteMany: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "apikey";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "configId"
                    | "name"
                    | "start"
                    | "referenceId"
                    | "prefix"
                    | "key"
                    | "userId"
                    | "refillInterval"
                    | "refillAmount"
                    | "lastRefillAt"
                    | "enabled"
                    | "rateLimitEnabled"
                    | "rateLimitTimeWindow"
                    | "rateLimitMax"
                    | "requestCount"
                    | "remaining"
                    | "lastRequest"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "permissions"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "tokenEndpointAuthMethod"
                    | "grantTypes"
                    | "responseTypes"
                    | "public"
                    | "type"
                    | "requirePKCE"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "authTime"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onDeleteHandle?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any,
        Name
      >;
      deleteOne: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "apikey";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "configId"
                    | "name"
                    | "start"
                    | "referenceId"
                    | "prefix"
                    | "key"
                    | "userId"
                    | "refillInterval"
                    | "refillAmount"
                    | "lastRefillAt"
                    | "enabled"
                    | "rateLimitEnabled"
                    | "rateLimitTimeWindow"
                    | "rateLimitMax"
                    | "requestCount"
                    | "remaining"
                    | "lastRequest"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "permissions"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "tokenEndpointAuthMethod"
                    | "grantTypes"
                    | "responseTypes"
                    | "public"
                    | "type"
                    | "requirePKCE"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "authTime"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onDeleteHandle?: string;
        },
        any,
        Name
      >;
      findMany: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          limit?: number;
          model:
            | "user"
            | "session"
            | "account"
            | "verification"
            | "jwks"
            | "apikey"
            | "oauthClient"
            | "oauthRefreshToken"
            | "oauthAccessToken"
            | "oauthConsent";
          offset?: number;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          select?: Array<string>;
          sortBy?: { direction: "asc" | "desc"; field: string };
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              | string
              | number
              | boolean
              | Array<string>
              | Array<number>
              | null;
          }>;
        },
        any,
        Name
      >;
      findOne: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          model:
            | "user"
            | "session"
            | "account"
            | "verification"
            | "jwks"
            | "apikey"
            | "oauthClient"
            | "oauthRefreshToken"
            | "oauthAccessToken"
            | "oauthConsent";
          select?: Array<string>;
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              | string
              | number
              | boolean
              | Array<string>
              | Array<number>
              | null;
          }>;
        },
        any,
        Name
      >;
      updateMany: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                update: {
                  createdAt?: number;
                  email?: string;
                  emailVerified?: boolean;
                  image?: null | string;
                  name?: string;
                  updatedAt?: number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  ipAddress?: null | string;
                  token?: string;
                  updatedAt?: number;
                  userAgent?: null | string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                update: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId?: string;
                  createdAt?: number;
                  idToken?: null | string;
                  password?: null | string;
                  providerId?: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  identifier?: string;
                  updatedAt?: number;
                  value?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                update: {
                  createdAt?: number;
                  expiresAt?: null | number;
                  privateKey?: string;
                  publicKey?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "apikey";
                update: {
                  configId?: null | string;
                  createdAt?: number;
                  enabled?: null | boolean;
                  expiresAt?: null | number;
                  key?: string;
                  lastRefillAt?: null | number;
                  lastRequest?: null | number;
                  metadata?: null | string;
                  name?: null | string;
                  permissions?: null | string;
                  prefix?: null | string;
                  rateLimitEnabled?: null | boolean;
                  rateLimitMax?: null | number;
                  rateLimitTimeWindow?: null | number;
                  referenceId?: null | string;
                  refillAmount?: null | number;
                  refillInterval?: null | number;
                  remaining?: null | number;
                  requestCount?: null | number;
                  start?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "configId"
                    | "name"
                    | "start"
                    | "referenceId"
                    | "prefix"
                    | "key"
                    | "userId"
                    | "refillInterval"
                    | "refillAmount"
                    | "lastRefillAt"
                    | "enabled"
                    | "rateLimitEnabled"
                    | "rateLimitTimeWindow"
                    | "rateLimitMax"
                    | "requestCount"
                    | "remaining"
                    | "lastRequest"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "permissions"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                update: {
                  clientId?: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  public?: null | boolean;
                  redirectUris?: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  type?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "tokenEndpointAuthMethod"
                    | "grantTypes"
                    | "responseTypes"
                    | "public"
                    | "type"
                    | "requirePKCE"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                update: {
                  authTime?: null | number;
                  clientId?: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  revoked?: null | number;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "authTime"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  scopes?: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onUpdateHandle?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any,
        Name
      >;
      updateOne: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                update: {
                  createdAt?: number;
                  email?: string;
                  emailVerified?: boolean;
                  image?: null | string;
                  name?: string;
                  updatedAt?: number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  ipAddress?: null | string;
                  token?: string;
                  updatedAt?: number;
                  userAgent?: null | string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                update: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId?: string;
                  createdAt?: number;
                  idToken?: null | string;
                  password?: null | string;
                  providerId?: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  identifier?: string;
                  updatedAt?: number;
                  value?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                update: {
                  createdAt?: number;
                  expiresAt?: null | number;
                  privateKey?: string;
                  publicKey?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "apikey";
                update: {
                  configId?: null | string;
                  createdAt?: number;
                  enabled?: null | boolean;
                  expiresAt?: null | number;
                  key?: string;
                  lastRefillAt?: null | number;
                  lastRequest?: null | number;
                  metadata?: null | string;
                  name?: null | string;
                  permissions?: null | string;
                  prefix?: null | string;
                  rateLimitEnabled?: null | boolean;
                  rateLimitMax?: null | number;
                  rateLimitTimeWindow?: null | number;
                  referenceId?: null | string;
                  refillAmount?: null | number;
                  refillInterval?: null | number;
                  remaining?: null | number;
                  requestCount?: null | number;
                  start?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "configId"
                    | "name"
                    | "start"
                    | "referenceId"
                    | "prefix"
                    | "key"
                    | "userId"
                    | "refillInterval"
                    | "refillAmount"
                    | "lastRefillAt"
                    | "enabled"
                    | "rateLimitEnabled"
                    | "rateLimitTimeWindow"
                    | "rateLimitMax"
                    | "requestCount"
                    | "remaining"
                    | "lastRequest"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "permissions"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                update: {
                  clientId?: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  public?: null | boolean;
                  redirectUris?: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  type?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "tokenEndpointAuthMethod"
                    | "grantTypes"
                    | "responseTypes"
                    | "public"
                    | "type"
                    | "requirePKCE"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                update: {
                  authTime?: null | number;
                  clientId?: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  revoked?: null | number;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "authTime"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "scopes"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  scopes?: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onUpdateHandle?: string;
        },
        any,
        Name
      >;
    };
  };
