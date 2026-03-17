import type { ConvexHttpClient } from 'convex/browser';

export interface InteractionHandlerContext {
  convex: ConvexHttpClient;
  apiSecret: string;
}
