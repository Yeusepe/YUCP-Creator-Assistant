/**
 * Records the public origin a client called, for proxied Better Auth requests.
 *
 * Convex only ever sees its own *.convex.site URL, but RFC 9449 §4.3 binds a DPoP
 * proof to the endpoint URL the *client* used, and Better Auth validates `htu`
 * against `Request.url`. Without these headers a correctly signed proof fails with
 * "DPoP proof htu does not match the request URL".
 * `canonicalizeBetterAuthProxyRequest` in convex/auth.ts consumes them.
 *
 * The values are always overwritten rather than preserved: a client-supplied
 * x-forwarded-host would otherwise let a caller choose the origin its own proof is
 * validated against.
 *
 * https://www.rfc-editor.org/rfc/rfc9449#section-4.3
 */
export function applyPublicOriginForwardingHeaders(headers: Headers, requestUrl: URL): Headers {
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(/:$/, ''));
  return headers;
}
