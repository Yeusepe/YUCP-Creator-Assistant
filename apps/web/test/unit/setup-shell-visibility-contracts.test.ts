import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalsCss = readFileSync(resolve(__dirname, '../../src/styles/globals.css'), 'utf8');
const loadingCss = readFileSync(resolve(__dirname, '../../src/styles/loading.css'), 'utf8');
const signInRedirectCss = readFileSync(
  resolve(__dirname, '../../src/styles/sign-in-redirect.css'),
  'utf8'
);
const jinxxySetupCss = readFileSync(
  resolve(__dirname, '../../src/styles/jinxxy-setup.css'),
  'utf8'
);
const lemonSqueezySetupCss = readFileSync(
  resolve(__dirname, '../../src/styles/lemonsqueezy-setup.css'),
  'utf8'
);
const verifyErrorCss = readFileSync(
  resolve(__dirname, '../../src/styles/verify-error.css'),
  'utf8'
);
const verifySuccessCss = readFileSync(
  resolve(__dirname, '../../src/styles/verify-success.css'),
  'utf8'
);
const verifyPurchaseCss = readFileSync(
  resolve(__dirname, '../../src/styles/verify-purchase.css'),
  'utf8'
);
const connectCss = readFileSync(resolve(__dirname, '../../src/styles/connect.css'), 'utf8');

const jinxxySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/jinxxy.tsx'),
  'utf8'
);
const lemonSqueezySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/lemonsqueezy.tsx'),
  'utf8'
);
const payhipSetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/payhip.tsx'),
  'utf8'
);
const vrchatSetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/vrchat.tsx'),
  'utf8'
);

describe('globals.css cascade layer contract', () => {
  it('wraps the CSS reset in @layer base so Tailwind utilities can override it', () => {
    // The *, *::before, *::after { padding: 0 } reset must be inside @layer base.
    // If it is unlayered (outside any @layer), it wins over ALL Tailwind @layer utilities
    // regardless of specificity, making every padding/margin utility class silently ignored.
    const layerBaseIdx = globalsCss.indexOf('@layer base {');
    const resetIdx = globalsCss.indexOf('padding: 0;');
    const layerBaseCloseIdx = globalsCss.indexOf('\n}', layerBaseIdx);
    expect(layerBaseIdx, '@layer base block is missing from globals.css').toBeGreaterThan(-1);
    expect(resetIdx, 'padding: 0 reset is missing from globals.css').toBeGreaterThan(-1);
    expect(resetIdx, 'padding: 0 must be inside @layer base, not unlayered').toBeGreaterThan(
      layerBaseIdx
    );
    expect(resetIdx, 'padding: 0 must be inside @layer base, not after it').toBeLessThan(
      layerBaseCloseIdx
    );
  });

  it('defines the shared cloud fallback surface and instant scene visibility styles globally', () => {
    expect(globalsCss).toContain('.cloud-background-surface {');
    expect(globalsCss).toContain('background: var(--cloud-fallback-sky);');
    expect(globalsCss).toContain('.cloud-background-surface.is-hidden');
    expect(globalsCss).toContain('.cloud-scene-layer {');
    expect(globalsCss).toContain('.cloud-scene-layer.is-ready {');
    expect(globalsCss).not.toContain('.cloud-layer-fade {');
  });

  it('reuses the sky fallback visual for the page loading overlay', () => {
    expect(loadingCss).toContain('#page-loading-overlay {');
    expect(loadingCss).toContain('background: var(--cloud-fallback-sky);');
    expect(loadingCss).toContain('#page-loading-overlay::after');
  });
});

describe('setup shell visibility contracts', () => {
  it('loads setup route styles through side-effect imports instead of head-linked route CSS', () => {
    expect(jinxxySetupSource).toContain("import '@/styles/jinxxy-setup.css';");
    expect(lemonSqueezySetupSource).toContain("import '@/styles/lemonsqueezy-setup.css';");
    expect(payhipSetupSource).toContain("import '@/styles/payhip-setup.css';");
    expect(vrchatSetupSource).toContain("import '@/styles/vrchat-verify.css';");
    expect(jinxxySetupSource).not.toContain('routeStylesheetLinks(');
    expect(lemonSqueezySetupSource).not.toContain('routeStylesheetLinks(');
    expect(payhipSetupSource).not.toContain('routeStylesheetLinks(');
    expect(vrchatSetupSource).not.toContain('routeStylesheetLinks(');
  });

  it('does not server-render the Jinxxy setup shell hidden by default', () => {
    expect(jinxxySetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
    expect(jinxxySetupSource).not.toContain('style={!isVisible ? { opacity: 0 } : undefined}');
  });

  it('does not server-render the Lemon Squeezy setup shell hidden by default', () => {
    expect(lemonSqueezySetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
  });

  it('renders the Lemon Squeezy background canvas inside the page-content shell', () => {
    const pageContentIndex = lemonSqueezySetupSource.indexOf('className={`page-content');
    const canvasIndex = lemonSqueezySetupSource.indexOf(
      '<BackgroundCanvasRoot position="absolute" />'
    );
    expect(pageContentIndex).toBeGreaterThan(-1);
    expect(canvasIndex).toBeGreaterThan(pageContentIndex);
  });

  it('renders the Payhip setup shell through a visible page-content wrapper', () => {
    expect(payhipSetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
    expect(payhipSetupSource).toContain(
      'className={`page-content fixed inset-0 flex flex-col items-center justify-center overflow-hidden'
    );
    expect(payhipSetupSource).toContain('<BackgroundCanvasRoot position="absolute" />');
    expect(payhipSetupSource).not.toContain('if (!isVisible) return null;');
  });

  it('keeps cloud-backed route wrappers transparent so the shared background stays visible', () => {
    expect(signInRedirectCss).not.toMatch(
      /\.sign-in-redirect-page\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(jinxxySetupCss).not.toMatch(
      /\.jinxxy-setup\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(lemonSqueezySetupCss).not.toMatch(
      /\.lemonsqueezy-setup\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(verifyErrorCss).not.toMatch(
      /\.verify-error-page-wrapper\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(verifySuccessCss).not.toMatch(
      /\.verify-success-page-wrapper\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(verifyPurchaseCss).not.toMatch(
      /\.vp-wrapper\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
    expect(connectCss).not.toMatch(
      /\.connect-page\s*\{[^}]*background-color:\s*var\(--bg-color\);/s
    );
  });
});
