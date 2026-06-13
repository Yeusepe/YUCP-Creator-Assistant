import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GLOBALS_CSS_PATH = join(__dirname, '../../src/styles/globals.css');
const HEROUI_THEME_CSS_PATH = join(__dirname, '../../src/styles/heroui-theme.css');
const ROOT_ROUTE_PATH = join(__dirname, '../../src/routes/__root.tsx');

describe('HeroUI glass theme contracts', () => {
  it('imports the HeroUI Pro glass theme after the base HeroUI layers', () => {
    const source = readFileSync(GLOBALS_CSS_PATH, 'utf8');

    expect(source).toContain('@import "@heroui/styles";');
    expect(source).toContain('@import "@heroui-pro/react/css";');
    expect(source).toContain('@import "@heroui-pro/react/themes/glass";');
  });

  it('keeps local HeroUI token overrides attached to the glass theme modes', () => {
    const source = readFileSync(HEROUI_THEME_CSS_PATH, 'utf8');

    expect(source).toContain('[data-theme="glass-light"]');
    expect(source).toContain('[data-theme="glass-dark"]');
  });

  it('sets the document theme to glass-light or glass-dark before first paint', () => {
    const source = readFileSync(ROOT_ROUTE_PATH, 'utf8');

    expect(source).toContain("document.documentElement.dataset.theme=d?'glass-dark':'glass-light'");
    expect(source).toContain("document.documentElement.classList.toggle('dark',d)");
  });
});
