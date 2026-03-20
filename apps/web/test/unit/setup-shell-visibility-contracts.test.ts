import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const jinxxySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/jinxxy.tsx'),
  'utf8'
);
const lemonSqueezySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/lemonsqueezy.tsx'),
  'utf8'
);
const payhipSetupSource = readFileSync(resolve(__dirname, '../../src/routes/setup/payhip.tsx'), 'utf8');
const vrchatSetupSource = readFileSync(resolve(__dirname, '../../src/routes/setup/vrchat.tsx'), 'utf8');

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
    expect(jinxxySetupSource).not.toContain("style={!isVisible ? { opacity: 0 } : undefined}");
  });

  it('does not server-render the Lemon Squeezy setup shell hidden by default', () => {
    expect(lemonSqueezySetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
  });

  it('renders the Lemon Squeezy background canvas inside the page-content shell', () => {
    const pageContentIndex = lemonSqueezySetupSource.indexOf('className={`page-content');
    const canvasIndex = lemonSqueezySetupSource.indexOf('<BackgroundCanvasRoot position="absolute" />');
    expect(pageContentIndex).toBeGreaterThan(-1);
    expect(canvasIndex).toBeGreaterThan(pageContentIndex);
  });

  it('renders the Payhip setup shell through a visible page-content wrapper', () => {
    expect(payhipSetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
    expect(payhipSetupSource).toContain('className={`page-content fixed inset-0 flex flex-col items-center justify-center overflow-hidden');
    expect(payhipSetupSource).toContain('<BackgroundCanvasRoot position="absolute" />');
    expect(payhipSetupSource).not.toContain('if (!isVisible) return null;');
  });
});
