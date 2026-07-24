import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '../../src');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return Promise.resolve(/\.[jt]sx?$/.test(entry.name) ? [path] : []);
    })
  );
  return nested.flat();
}

const allowedInlineSvgFiles = new Set([
  'components/page/PageLoadingOverlay.tsx',
  'components/ui/Icon.tsx',
  'lib/creatorSuiteSignIn.tsx',
  'routes/_authenticated/verify/purchase.lazy.tsx',
  'routes/setup/discord-role.tsx',
  'routes/setup/jinxxy.lazy.tsx',
  'routes/setup/lemonsqueezy.lazy.tsx',
  'routes/setup/payhip.lazy.tsx',
]);

const retiredGenericImageNames = [
  'Checkmark',
  'ClapStars',
  'Key',
  'Laptop',
  'Library',
  'Link',
  'PersonKey',
  'Refresh',
  'Shield',
  'Timer',
  'World',
  'Wrench',
  'X',
];

const dashboardIconThemes = ['sky', 'amber', 'teal', 'violet', 'rose'] as const;
const minimumAdjacentLayerContrast = 3;
const maximumColoredLayerContrast = 3.5;

function readThemeColors(stylesheet: string, theme: string, dark = false): string[] {
  const block = stylesheet.match(
    new RegExp(
      `\\n${dark ? '\\.dark ' : ''}\\.sidebar-nav-group\\[data-icon-theme="${theme}"\\] \\{([^}]*)\\}`,
      'u'
    )
  )?.[1];
  if (!block) return [];

  return [
    '--sidebar-icon-primary',
    '--sidebar-icon-accent',
    '--sidebar-icon-active-primary',
    '--sidebar-icon-active-accent',
  ].map((property) => block.match(new RegExp(`${property}: ([^;]+);`, 'u'))?.[1] ?? '');
}

function oklchToRelativeLuminance(color: string): number {
  const match = color.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/u);
  if (!match) {
    throw new Error(`Expected an opaque OKLCH color, received: ${color}`);
  }

  const rawLightness = Number(match[1]);
  const lightness = match[2] === '%' ? rawLightness / 100 : rawLightness;
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return (
    0.2126 * Math.max(0, Math.min(1, red)) +
    0.7152 * Math.max(0, Math.min(1, green)) +
    0.0722 * Math.max(0, Math.min(1, blue))
  );
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [first, second]
    .map(oklchToRelativeLuminance)
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('icon consistency', () => {
  it('uses the storage-backed icon registry instead of generic icon packages or retired image glyphs', async () => {
    const violations: string[] = [];

    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      const path = relative(sourceRoot, file).replaceAll('\\', '/');

      if (/(?:from|require\()\s*['"](?:lucide-react|react-icons|@heroicons)/.test(source)) {
        violations.push(`${path}: generic icon package`);
      }

      for (const name of retiredGenericImageNames) {
        if (source.includes(`/Icons/${name}.`)) {
          violations.push(`${path}: retired /Icons/${name} image`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps inline SVG limited to the renderer, brand marks, and purpose-built illustrations', async () => {
    const unexpectedInlineSvgFiles: string[] = [];

    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      const path = relative(sourceRoot, file).replaceAll('\\', '/');
      if (source.includes('<svg') && !allowedInlineSvgFiles.has(path)) {
        unexpectedInlineSvgFiles.push(path);
      }
    }

    expect(unexpectedInlineSvgFiles).toEqual([]);
  });

  it('gives every sidebar section distinct selected and unselected two-tone colors', async () => {
    const [stylesheet, globalStylesheet, dashboardRoute, accountRoute] = await Promise.all([
      readFile(resolve(sourceRoot, 'styles/dashboard/partials/02-shell-sidebar.css'), 'utf8'),
      readFile(resolve(sourceRoot, 'styles/globals.css'), 'utf8'),
      readFile(resolve(sourceRoot, 'routes/_authenticated/dashboard.lazy.tsx'), 'utf8'),
      readFile(resolve(sourceRoot, 'routes/_authenticated/account.lazy.tsx'), 'utf8'),
    ]);
    const palettes = dashboardIconThemes.flatMap((theme) => [
      readThemeColors(stylesheet, theme),
      readThemeColors(stylesheet, theme, true),
    ]);

    expect(palettes.every((palette) => palette.length === 4 && palette.every(Boolean))).toBe(true);
    expect(
      new Set(dashboardIconThemes.map((theme) => readThemeColors(stylesheet, theme)[1])).size
    ).toBe(dashboardIconThemes.length);
    expect(
      new Set(dashboardIconThemes.map((theme) => readThemeColors(stylesheet, theme)[3])).size
    ).toBe(dashboardIconThemes.length);

    for (const [primary, accent, activePrimary, activeAccent] of palettes) {
      const restingContrast = contrastRatio(primary, accent);
      const activeContrast = contrastRatio(activePrimary, activeAccent);
      expect(restingContrast).toBeGreaterThanOrEqual(minimumAdjacentLayerContrast);
      expect(restingContrast).toBeLessThanOrEqual(maximumColoredLayerContrast);
      expect(activeContrast).toBeGreaterThanOrEqual(minimumAdjacentLayerContrast);
      expect(activeContrast).toBeLessThanOrEqual(maximumColoredLayerContrast);
    }

    const neutralPairs = [
      ['oklch(0.3 0.02 245)', 'oklch(0.68 0.02 245)'],
      ['oklch(0.97 0.01 235)', 'oklch(0.55 0.04 235)'],
    ] as const;
    for (const [primary, accent] of neutralPairs) {
      expect(globalStylesheet).toContain(`--icon-neutral-primary: ${primary};`);
      expect(globalStylesheet).toContain(`--icon-neutral-accent: ${accent};`);
      expect(contrastRatio(primary, accent)).toBeGreaterThanOrEqual(minimumAdjacentLayerContrast);
    }
    expect(globalStylesheet).toContain('.yucp-icon[data-icon-color="interaction"]');
    expect(globalStylesheet).toContain('.yucp-icon[data-icon-color="always"]');
    expect(globalStylesheet).not.toContain('contrast-color(');

    for (const theme of dashboardIconThemes) {
      expect(dashboardRoute).toContain(`data-icon-theme="${theme}"`);
    }
    for (const theme of dashboardIconThemes.slice(0, 4)) {
      expect(accountRoute).toContain(`theme: '${theme}'`);
    }

    expect(stylesheet).toMatch(/\.sidebar-nav-icon \{[^}]*width: 16px;[^}]*height: 16px;/su);
  });
});
