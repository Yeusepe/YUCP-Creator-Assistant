import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { tables as generatedTables } from './schema.generated';

export const tables = {
  ...generatedTables,
  oauthClientResource: defineTable({
    clientId: v.string(),
    resourceId: v.string(),
    metadata: v.optional(v.union(v.null(), v.string())),
    createdAt: v.optional(v.union(v.null(), v.number())),
  })
    .index('clientId', ['clientId'])
    .index('resourceId', ['resourceId'])
    .index('clientId_resourceId', ['clientId', 'resourceId']),
  passkey: defineTable({
    name: v.optional(v.union(v.null(), v.string())),
    publicKey: v.string(),
    userId: v.string(),
    credentialID: v.string(),
    counter: v.number(),
    deviceType: v.string(),
    backedUp: v.boolean(),
    transports: v.optional(v.union(v.null(), v.string())),
    createdAt: v.optional(v.union(v.null(), v.number())),
    aaguid: v.optional(v.union(v.null(), v.string())),
  })
    .index('userId', ['userId'])
    .index('credentialID', ['credentialID'])
    .index('counter_credentialID', ['counter', 'credentialID']),
};

const schema = defineSchema(tables);

export default schema;
