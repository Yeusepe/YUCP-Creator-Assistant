import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '@/hooks/useTheme';

function ThemeToggleProbe() {
  const { isDark } = useTheme();

  return (
    <button id="theme-toggle" type="button">
      <svg className={`sun-icon${isDark ? '' : ' hidden'}`} />
      <svg className={`moon-icon${isDark ? ' hidden' : ''}`} />
    </button>
  );
}

describe('useTheme hydration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
  });

  it('hydrates without a class mismatch when a dark theme is stored', async () => {
    localStorage.setItem('yucp_theme', 'dark');

    const originalWindow = globalThis.window;
    vi.stubGlobal('window', undefined);
    const serverMarkup = renderToString(<ThemeToggleProbe />);
    vi.stubGlobal('window', originalWindow);

    const container = document.createElement('div');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      hydrateRoot(container, <ThemeToggleProbe />);
      await Promise.resolve();
    });

    const errorOutput = consoleError.mock.calls.flat().join('\n');
    expect(errorOutput).not.toContain(
      "A tree hydrated but some attributes of the server rendered HTML didn't match the client properties."
    );
    expect(errorOutput).not.toContain('hydration-mismatch');
    expect(document.documentElement.dataset.theme).toBe('glass-dark');
  });
});
