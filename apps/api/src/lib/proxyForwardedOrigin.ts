export function applyPublicOriginForwardingHeaders(headers: Headers, requestUrl: URL): Headers {
  const host = requestUrl.host;

  const incomingProto = headers.get('x-forwarded-proto')?.trim().toLowerCase();
  const protocol = incomingProto === 'https' ? 'https' : requestUrl.protocol.replace(/:$/, '');

  headers.set('x-better-auth-forwarded-host', host);
  headers.set('x-better-auth-forwarded-proto', protocol);
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', protocol);
  return headers;
}
