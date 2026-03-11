/**
 * Tunnel detection utility
 *
 * Auto-detects running tunnel services (Tailscale Funnel, ngrok)
 * and returns the public URL for webhook endpoints.
 */

import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

interface TunnelResult {
  url: string;
  provider: 'tailscale' | 'ngrok' | 'none';
}

/**
 * Try to detect Tailscale Funnel by running `tailscale status --json`
 * and checking if the machine has a DNS name with funnel enabled.
 */
async function detectTailscale(port: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(['tailscale', 'status', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return null;

    const status = JSON.parse(text);
    const dnsName: string | undefined = status?.Self?.DNSName;
    if (!dnsName) return null;

    // DNSName ends with a dot, trim it
    const hostname = dnsName.replace(/\.$/, '');
    const url = `https://${hostname}`;

    logger.info('Tailscale tunnel detected', { url, hostname });
    return url;
  } catch {
    return null;
  }
}

/**
 * Try to detect ngrok by querying its local API at http://localhost:4040/api/tunnels
 */
async function detectNgrok(port: number): Promise<string | null> {
  try {
    const res = await fetch('http://localhost:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      tunnels: Array<{
        public_url: string;
        proto: string;
        config: { addr: string };
      }>;
    };

    // Find the HTTPS tunnel pointing to our port
    const tunnel = data.tunnels?.find(
      (t) =>
        t.proto === 'https' &&
        (t.config?.addr?.includes(`:${port}`) || t.config?.addr === `http://localhost:${port}`)
    );

    if (tunnel?.public_url) {
      logger.info('ngrok tunnel detected', { url: tunnel.public_url });
      return tunnel.public_url;
    }

    // Fallback: just grab the first HTTPS tunnel
    const anyHttps = data.tunnels?.find((t) => t.proto === 'https');
    if (anyHttps?.public_url) {
      logger.info('ngrok tunnel detected (fallback)', { url: anyHttps.public_url });
      return anyHttps.public_url;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the best available tunnel URL.
 * Checks Tailscale first, then ngrok.
 * Returns the localhost fallback if no tunnel is detected.
 */
export async function detectTunnelUrl(port = 3001): Promise<TunnelResult> {
  // Check Tailscale first (since user has it in their dev script)
  const tailscaleUrl = await detectTailscale(port);
  if (tailscaleUrl) {
    return { url: tailscaleUrl, provider: 'tailscale' };
  }

  // Check ngrok
  const ngrokUrl = await detectNgrok(port);
  if (ngrokUrl) {
    return { url: ngrokUrl, provider: 'ngrok' };
  }

  return { url: `http://localhost:${port}`, provider: 'none' };
}
