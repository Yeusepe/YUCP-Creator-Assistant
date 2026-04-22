import {
  type AuthOriginOptions,
  buildAllowedBrowserOrigins as buildAllowedBrowserOriginsRuntime,
  buildTrustedBrowserOrigins as buildTrustedBrowserOriginsRuntime,
} from './authOrigins-runtime.js';

export type { AuthOriginOptions } from './authOrigins-runtime.js';

export const buildAllowedBrowserOrigins = (options: AuthOriginOptions): string[] =>
  buildAllowedBrowserOriginsRuntime(options);

export const buildTrustedBrowserOrigins = (options: AuthOriginOptions): string[] =>
  buildTrustedBrowserOriginsRuntime(options);
