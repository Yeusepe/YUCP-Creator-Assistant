export function getClientAddress(request: Request): string {
  const cloudflareConnectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflareConnectingIp) {
    return cloudflareConnectingIp;
  }

  return 'unknown';
}
