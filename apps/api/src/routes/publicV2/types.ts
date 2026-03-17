export interface PublicV2Config {
  convexUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  encryptionSecret: string;
  oauthAudience?: string;
}

export type RouteHandler = (
  request: Request,
  pathname: string,
  authUserId: string,
  config: PublicV2Config,
) => Promise<Response>;
