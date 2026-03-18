import { v } from 'convex/values';
import { type QueryCtx, mutation, query } from './_generated/server';
import { createAuth } from './auth';
import { requireApiSecret } from './lib/apiAuth';

type OAuthClientRecord = {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  scope?: string;
  user_id?: string;
  client_id_issued_at?: number;
  client_name?: string | null;
  client_uri?: string | null;
  logo_uri?: string | null;
  contacts?: string[];
  tos_uri?: string | null;
  policy_uri?: string | null;
  software_id?: string | null;
  software_version?: string | null;
  software_statement?: string | null;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  token_endpoint_auth_method?: string | null;
  grant_types?: string[];
  response_types?: string[];
  public?: boolean;
  type?: string | null;
  disabled?: boolean;
  skip_consent?: boolean;
  enable_end_session?: boolean;
  require_pkce?: boolean;
  subject_type?: string | null;
  reference_id?: string | null;
};

type OAuthClientUpdateInput = Partial<
  Omit<OAuthClientRecord, 'client_id' | 'client_secret' | 'client_id_issued_at' | 'public'>
> & {
  client_name?: string;
  redirect_uris?: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  post_logout_redirect_uris?: string[];
  metadata?: Record<string, unknown>;
};

interface BetterAuthOAuthServerApi {
  getOAuthClients(): Promise<unknown>;
  getOAuthClient(args: { query: { client_id: string } }): Promise<unknown>;
  getOAuthClientPublic(args: { query: { client_id: string } }): Promise<unknown>;
  createOAuthClient(args: { body: Record<string, unknown> }): Promise<unknown>;
  updateOAuthClient(args: { body: { client_id: string; update: Record<string, unknown> } }): Promise<unknown>;
  rotateClientSecret(args: { body: { client_id: string } }): Promise<unknown>;
  deleteOAuthClient(args: { body: { client_id: string } }): Promise<unknown>;
}

interface OAuthClientResponse {
  client_id?: string;
  client_secret?: string;
  client_secret_expires_at?: number | null;
  scope?: string;
  user_id?: string;
  client_id_issued_at?: number | null;
  client_name?: string | null;
  client_uri?: string | null;
  logo_uri?: string | null;
  contacts?: string[] | null;
  tos_uri?: string | null;
  policy_uri?: string | null;
  software_id?: string | null;
  software_version?: string | null;
  software_statement?: string | null;
  redirect_uris?: string[] | null;
  post_logout_redirect_uris?: string[] | null;
  token_endpoint_auth_method?: string | null;
  grant_types?: string[] | null;
  response_types?: string[] | null;
  public?: boolean | null;
  type?: string | null;
  disabled?: boolean | null;
  skip_consent?: boolean | null;
  enable_end_session?: boolean | null;
  require_pkce?: boolean | null;
  subject_type?: string | null;
  reference_id?: string | null;
}

const OAuthClientValue = v.object({
  client_id: v.string(),
  client_secret: v.optional(v.string()),
  client_secret_expires_at: v.optional(v.number()),
  scope: v.optional(v.string()),
  user_id: v.optional(v.string()),
  client_id_issued_at: v.optional(v.number()),
  client_name: v.optional(v.union(v.string(), v.null())),
  client_uri: v.optional(v.union(v.string(), v.null())),
  logo_uri: v.optional(v.union(v.string(), v.null())),
  contacts: v.optional(v.array(v.string())),
  tos_uri: v.optional(v.union(v.string(), v.null())),
  policy_uri: v.optional(v.union(v.string(), v.null())),
  software_id: v.optional(v.union(v.string(), v.null())),
  software_version: v.optional(v.union(v.string(), v.null())),
  software_statement: v.optional(v.union(v.string(), v.null())),
  redirect_uris: v.array(v.string()),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  token_endpoint_auth_method: v.optional(v.union(v.string(), v.null())),
  grant_types: v.optional(v.array(v.string())),
  response_types: v.optional(v.array(v.string())),
  public: v.optional(v.boolean()),
  type: v.optional(v.union(v.string(), v.null())),
  disabled: v.optional(v.boolean()),
  skip_consent: v.optional(v.boolean()),
  enable_end_session: v.optional(v.boolean()),
  require_pkce: v.optional(v.boolean()),
  subject_type: v.optional(v.union(v.string(), v.null())),
  reference_id: v.optional(v.union(v.string(), v.null())),
});

function normalizeOAuthClientRecord(
  value: OAuthClientResponse | null | undefined,
  includeSecret = false
): OAuthClientRecord {
  if (!value?.client_id) {
    throw new Error('Better Auth returned an empty OAuth client record');
  }

  const normalized: OAuthClientRecord = {
    client_id: value.client_id,
    redirect_uris: value.redirect_uris ?? [],
  };

  if (includeSecret && value.client_secret) {
    normalized.client_secret = value.client_secret;
  }
  if (typeof value.client_secret_expires_at === 'number') {
    normalized.client_secret_expires_at = value.client_secret_expires_at;
  }
  if (typeof value.scope === 'string' && value.scope.trim()) {
    normalized.scope = value.scope;
  }
  if (typeof value.user_id === 'string' && value.user_id.trim()) {
    normalized.user_id = value.user_id;
  }
  if (typeof value.client_id_issued_at === 'number') {
    normalized.client_id_issued_at = value.client_id_issued_at;
  }
  if (value.client_name !== undefined) {
    normalized.client_name = value.client_name ?? null;
  }
  if (value.client_uri !== undefined) {
    normalized.client_uri = value.client_uri ?? null;
  }
  if (value.logo_uri !== undefined) {
    normalized.logo_uri = value.logo_uri ?? null;
  }
  if (Array.isArray(value.contacts)) {
    normalized.contacts = value.contacts;
  }
  if (value.tos_uri !== undefined) {
    normalized.tos_uri = value.tos_uri ?? null;
  }
  if (value.policy_uri !== undefined) {
    normalized.policy_uri = value.policy_uri ?? null;
  }
  if (value.software_id !== undefined) {
    normalized.software_id = value.software_id ?? null;
  }
  if (value.software_version !== undefined) {
    normalized.software_version = value.software_version ?? null;
  }
  if (value.software_statement !== undefined) {
    normalized.software_statement = value.software_statement ?? null;
  }
  if (Array.isArray(value.post_logout_redirect_uris)) {
    normalized.post_logout_redirect_uris = value.post_logout_redirect_uris;
  }
  if (value.token_endpoint_auth_method !== undefined) {
    normalized.token_endpoint_auth_method = value.token_endpoint_auth_method ?? null;
  }
  if (Array.isArray(value.grant_types)) {
    normalized.grant_types = value.grant_types;
  }
  if (Array.isArray(value.response_types)) {
    normalized.response_types = value.response_types;
  }
  if (typeof value.public === 'boolean') {
    normalized.public = value.public;
  }
  if (value.type !== undefined) {
    normalized.type = value.type ?? null;
  }
  if (typeof value.disabled === 'boolean') {
    normalized.disabled = value.disabled;
  }
  if (typeof value.skip_consent === 'boolean') {
    normalized.skip_consent = value.skip_consent;
  }
  if (typeof value.enable_end_session === 'boolean') {
    normalized.enable_end_session = value.enable_end_session;
  }
  if (typeof value.require_pkce === 'boolean') {
    normalized.require_pkce = value.require_pkce;
  }
  if (value.subject_type !== undefined) {
    normalized.subject_type = value.subject_type ?? null;
  }
  if (value.reference_id !== undefined) {
    normalized.reference_id = value.reference_id ?? null;
  }

  return normalized;
}

function getOAuthApi(ctx: QueryCtx) {
  const auth = createAuth(ctx);
  return auth.api as unknown as BetterAuthOAuthServerApi;
}

export const listOAuthClients = query({
  args: {},
  returns: v.array(OAuthClientValue),
  handler: async (ctx) => {
    const clients = (await getOAuthApi(ctx).getOAuthClients()) as OAuthClientResponse[] | null;
    return (clients ?? []).map((client) => normalizeOAuthClientRecord(client));
  },
});

export const getOAuthClient = query({
  args: {
    clientId: v.string(),
  },
  returns: v.union(v.null(), OAuthClientValue),
  handler: async (ctx, args) => {
    const client = (await getOAuthApi(ctx).getOAuthClient({
      query: { client_id: args.clientId },
    })) as OAuthClientResponse | null;

    return client ? normalizeOAuthClientRecord(client) : null;
  },
});

export const getOAuthClientPublic = query({
  args: {
    clientId: v.string(),
  },
  returns: v.union(v.null(), OAuthClientValue),
  handler: async (ctx, args) => {
    const client = (await getOAuthApi(ctx).getOAuthClientPublic({
      query: { client_id: args.clientId },
    })) as OAuthClientResponse | null;

    return client ? normalizeOAuthClientRecord(client) : null;
  },
});

export const createOAuthClient = mutation({
  args: {
    client_name: v.optional(v.string()),
    client_uri: v.optional(v.string()),
    logo_uri: v.optional(v.string()),
    contacts: v.optional(v.array(v.string())),
    tos_uri: v.optional(v.string()),
    policy_uri: v.optional(v.string()),
    software_id: v.optional(v.string()),
    software_version: v.optional(v.string()),
    software_statement: v.optional(v.string()),
    redirect_uris: v.array(v.string()),
    post_logout_redirect_uris: v.optional(v.array(v.string())),
    token_endpoint_auth_method: v.optional(v.string()),
    grant_types: v.optional(v.array(v.string())),
    response_types: v.optional(v.array(v.string())),
    type: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    skip_consent: v.optional(v.boolean()),
    enable_end_session: v.optional(v.boolean()),
    require_pkce: v.optional(v.boolean()),
    subject_type: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    scope: v.optional(v.string()),
  },
  returns: OAuthClientValue,
  handler: async (ctx, args) => {
    const response = (await getOAuthApi(ctx).createOAuthClient({
      body: {
        ...args,
      },
    })) as OAuthClientResponse;

    return normalizeOAuthClientRecord(response, true);
  },
});

export const updateOAuthClient = mutation({
  args: {
    clientId: v.string(),
    update: v.object({
      client_name: v.optional(v.string()),
      client_uri: v.optional(v.string()),
      logo_uri: v.optional(v.string()),
      contacts: v.optional(v.array(v.string())),
      tos_uri: v.optional(v.string()),
      policy_uri: v.optional(v.string()),
      software_id: v.optional(v.string()),
      software_version: v.optional(v.string()),
      software_statement: v.optional(v.string()),
      redirect_uris: v.optional(v.array(v.string())),
      post_logout_redirect_uris: v.optional(v.array(v.string())),
      token_endpoint_auth_method: v.optional(v.string()),
      grant_types: v.optional(v.array(v.string())),
      response_types: v.optional(v.array(v.string())),
      type: v.optional(v.string()),
      metadata: v.optional(v.record(v.string(), v.any())),
      disabled: v.optional(v.boolean()),
      skip_consent: v.optional(v.boolean()),
      enable_end_session: v.optional(v.boolean()),
      require_pkce: v.optional(v.boolean()),
      subject_type: v.optional(v.string()),
      scope: v.optional(v.string()),
    }),
  },
  returns: OAuthClientValue,
  handler: async (ctx, args) => {
    const response = (await getOAuthApi(ctx).updateOAuthClient({
      body: {
        client_id: args.clientId,
        update: args.update,
      },
    })) as OAuthClientResponse;

    return normalizeOAuthClientRecord(response);
  },
});

export const rotateOAuthClientSecret = mutation({
  args: {
    clientId: v.string(),
  },
  returns: OAuthClientValue,
  handler: async (ctx, args) => {
    const response = (await getOAuthApi(ctx).rotateClientSecret({
      body: {
        client_id: args.clientId,
      },
    })) as OAuthClientResponse;

    return normalizeOAuthClientRecord(response, true);
  },
});

export const deleteOAuthClient = mutation({
  args: {
    clientId: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    await getOAuthApi(ctx).deleteOAuthClient({
      body: {
        client_id: args.clientId,
      },
    });

    return { success: true };
  },
});
