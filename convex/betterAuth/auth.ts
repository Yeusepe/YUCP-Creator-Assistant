/**
 * Schema-generation shim for Better Auth local install.
 * This file must stay schema-safe and must not become the runtime auth entrypoint.
 */

import { betterAuth } from 'better-auth';
import { convexAdapter } from '@convex-dev/better-auth';
import { createSchemaAuthOptions } from './options';

const schemaGenerationDatabase = convexAdapter(
  {} as never,
  { adapter: {} } as never
);

export const auth = betterAuth({
  ...createSchemaAuthOptions(),
  database: schemaGenerationDatabase,
});

export default auth;
