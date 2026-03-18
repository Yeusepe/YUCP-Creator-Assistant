import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTheme } from '@/hooks/useTheme';

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  localStorage.clear();
});

describe('useTheme', () => {
  it('defaults to light mode when no localStorage value', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);
  });

  it('initializes to dark mode when localStorage has yucp_theme=dark', () => {
    localStorage.setItem('yucp_theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
  });

  it('toggles theme and persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.isDark).toBe(true);
    expect(localStorage.getItem('yucp_theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.isDark).toBe(false);
    expect(localStorage.getItem('yucp_theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
