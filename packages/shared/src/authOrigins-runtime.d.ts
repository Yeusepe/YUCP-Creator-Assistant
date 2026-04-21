export type AuthOriginOptions = Readonly<{
  siteUrl?: string | null;
  frontendUrl?: string | null;
  additionalOrigins?: ReadonlyArray<string | null | undefined>;
}>;

export function buildAllowedBrowserOrigins(options: AuthOriginOptions): string[];
export function buildTrustedBrowserOrigins(options: AuthOriginOptions): string[];
