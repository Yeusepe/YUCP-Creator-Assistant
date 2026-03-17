/**
 * Product ID Parsers
 *
 * Centralizes URL and ID parsing for each provider's product type.
 * parseProductId(providerKey, input) extracts the canonical product ID
 * from a URL or raw ID string.
 *
 * Adding a new provider: add one entry to PRODUCT_PARSERS.
 */

export type ProductParseResult = { ok: true; productId: string } | { ok: false; error: string };

type ProductParser = (input: string) => ProductParseResult;

const PRODUCT_PARSERS: Record<string, ProductParser> = {
  gumroad: (input) => {
    const trimmed = input.trim();
    // URL formats: https://gumroad.com/l/abc123, https://user.gumroad.com/l/abc123
    const urlMatch = trimmed.match(/gumroad\.com\/l\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return { ok: true, productId: urlMatch[1] };
    // Dashboard URL format: https://app.gumroad.com/products/abc123
    const productsMatch = trimmed.match(/gumroad\.com\/products\/([a-zA-Z0-9_-]+)/);
    if (productsMatch) return { ok: true, productId: productsMatch[1] };
    // Raw product ID: alphanumeric, hyphens, underscores, and base64 padding (=).
    // Gumroad uses both URL slugs (abc123) and base64-encoded IDs (QAJc7A==).
    if (/^[a-zA-Z0-9_+/==-]{3,}$/.test(trimmed)) {
      return { ok: true, productId: trimmed };
    }
    return { ok: false, error: 'Could not parse Gumroad product URL or ID' };
  },

  jinxxy: (input) => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return { ok: false, error: 'Jinxxy product ID is required' };
    return { ok: true, productId: trimmed };
  },

  lemonsqueezy: (input) => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return { ok: false, error: 'Lemon Squeezy product ID is required' };
    // Strip numeric ID from URL if given
    const urlMatch = trimmed.match(/lemonsqueezy\.com\/.*?\/(\d+)/);
    if (urlMatch) return { ok: true, productId: urlMatch[1] };
    return { ok: true, productId: trimmed };
  },

  payhip: (input) => {
    const trimmed = input.trim();
    // URL format: https://payhip.com/b/CODE
    const urlMatch = trimmed.match(/payhip\.com\/b\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return { ok: true, productId: urlMatch[1] };
    // Raw permalink
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && trimmed.length > 0) {
      return { ok: true, productId: trimmed };
    }
    return { ok: false, error: 'Could not parse Payhip product permalink' };
  },

  vrchat: (input) => {
    const trimmed = input.trim();
    // Full URL: https://vrchat.com/home/avatar/avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const urlMatch = trimmed.match(/vrchat\.com\/home\/avatar\/(avtr_[a-f0-9-]+)/i);
    if (urlMatch) return { ok: true, productId: urlMatch[1] };
    // Raw avatar ID: avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    if (/^avtr_[a-f0-9-]+$/i.test(trimmed)) {
      return { ok: true, productId: trimmed };
    }
    return {
      ok: false,
      error:
        'Could not parse VRChat avatar URL or ID. Use https://vrchat.com/home/avatar/avtr_xxx or avtr_xxx',
    };
  },
};

/**
 * Parse a product ID or URL for the given provider.
 * Returns { ok: true, productId } on success or { ok: false, error } on failure.
 * Returns { ok: false, error: 'Unknown provider' } for providers without a parser.
 */
export function parseProductId(providerKey: string, input: string): ProductParseResult {
  const parser = PRODUCT_PARSERS[providerKey];
  if (!parser) return { ok: false, error: `Unknown provider: ${providerKey}` };
  return parser(input);
}

/**
 * Returns true if the given provider has a product ID parser.
 */
export function hasProductParser(providerKey: string): boolean {
  return providerKey in PRODUCT_PARSERS;
}
