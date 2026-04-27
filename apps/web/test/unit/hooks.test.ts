import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTheme } from '@/hooks/useTheme';

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

describe('useTheme', () => {
  it('defaults to light mode when no localStorage value', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('glass-light');
  });

  it('initializes to dark mode when localStorage has yucp_theme=dark', () => {
    localStorage.setItem('yucp_theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('glass-dark');
  });

  it('toggles theme and persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.isDark).toBe(true);
    expect(localStorage.getItem('yucp_theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('glass-dark');

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.isDark).toBe(false);
    expect(localStorage.getItem('yucp_theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('glass-light');
  });
});
