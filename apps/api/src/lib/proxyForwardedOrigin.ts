/**
 * Records the public origin a client called, for proxied Better Auth requests.
 *
 * Convex only ever sees its own *.convex.site URL, but RFC 9449 §4.3 binds a DPoP
 * proof to the endpoint URL the *client* used, and Better Auth validates `htu`
 * against `Request.url`. Without this a correctly signed proof fails with
 * "DPoP proof htu does not match the request URL".
 *
 * The `x-better-auth-forwarded-*` names are the ones that actually survive the
 * trip. Convex's platform rewrites the standard `x-forwarded-*` headers before an
 * httpAction sees them, so `@convex-dev/better-auth` reads the prefixed pair in
 * `restoreOriginalForwardedHeaders` and copies it back onto the standard names,
 * which `canonicalizeBetterAuthProxyRequest` in convex/auth.ts then consumes.
 * Sending only the standard names is silently ineffective.
 *
 * Both pairs are set: the prefixed pair for the Convex component, and the
 * standard pair so any other consumer sees the same origin.
 *
 * Values are always overwritten rather than preserved: a client-supplied
 * forwarded host would otherwise let a caller choose the origin its own proof is
 * validated against.
 *
 * https://www.rfc-editor.org/rfc/rfc9449#section-4.3
 */
export function applyPublicOriginForwardingHeaders(headers: Headers, requestUrl: URL): Headers {
  const host = requestUrl.host;
  const protocol = requestUrl.protocol.replace(/:$/, '');

  headers.set('x-better-auth-forwarded-host', host);
  headers.set('x-better-auth-forwarded-proto', protocol);
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', protocol);
  return headers;
}
