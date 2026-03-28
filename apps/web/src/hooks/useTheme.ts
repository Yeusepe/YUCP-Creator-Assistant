import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'yucp_theme';

export function useTheme() {
  const [isDark, setIsDark] = useState(false);

  // Single effect handles both initialization and DOM sync.
  // Previously two separate effects caused a flash: the "sync" effect ran with
  // the stale `isDark = false` default and removed the `.dark` class the
  // blocking inline script had just set, producing a dark→light flash on load.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const next =
      stored === 'dark' || (stored === null && matchMedia('(prefers-color-scheme: dark)').matches);
    if (next) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    setIsDark(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      if (next) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return next;
    });
  }, []);

  return { isDark, toggleTheme };
}
