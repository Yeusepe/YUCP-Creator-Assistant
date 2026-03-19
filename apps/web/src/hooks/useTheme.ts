import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'yucp_theme';

export function useTheme() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const storedTheme = localStorage.getItem(STORAGE_KEY);
    const nextIsDark =
      storedTheme === null
        ? document.documentElement.classList.contains('dark')
        : storedTheme === 'dark';
    setIsDark(nextIsDark);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      return next;
    });
  }, []);

  return { isDark, toggleTheme };
}
