import '@testing-library/jest-dom/vitest';

process.env.CONVEX_SITE_URL ??= 'https://example.convex.site';
process.env.CONVEX_URL ??= 'https://example.convex.cloud';

if (!Element.prototype.getAnimations) {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
}
