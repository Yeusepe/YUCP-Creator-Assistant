/**
 * Get a Discord guild icon URL.
 */
export function getServerIconUrl(
  guildId: string,
  iconHash: string | null | undefined
): string | null {
  if (!iconHash) return null;
  const ext = iconHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=64`;
}

/**
 * Validate a URL is safe for redirection (same-origin or Discord).
 */
export function isSafeReturnUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) return true;
    if (parsed.hostname === 'discord.com' || parsed.hostname.endsWith('.discord.com')) return true;
    if (url.startsWith('discord://')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Copy text to clipboard with fallback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  }
}

/**
 * Normalize error codes to user-friendly messages.
 */
export function getErrorMessage(error: string): string {
  const messages: Record<string, string> = {
    link_expired: 'This link has expired or was already used.',
    invalid_token: 'The verification token is invalid.',
    session_expired: 'Your session has expired. Please try again.',
    server_error: 'Something went wrong on our end. Please try again later.',
    unauthorized: 'You are not authorized to perform this action.',
    not_found: 'The resource you are looking for was not found.',
    rate_limited: 'Too many requests. Please wait a moment and try again.',
  };
  return messages[error] ?? error.replace(/_/g, ' ');
}
