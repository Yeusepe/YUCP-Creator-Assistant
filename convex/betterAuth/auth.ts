/**
 * Schema-generation shim for Better Auth local install.
 * This file must stay schema-safe and must not become the runtime auth entrypoint.
 */

import { betterAuth } from 'better-auth';
import { createSchemaAuthOptions } from './options';

export const auth = betterAuth(createSchemaAuthOptions());

export default auth;
