export function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('yucp_theme', isDark ? 'dark' : 'light');

  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');
  if (sunIcon && moonIcon) {
    if (isDark) {
      sunIcon.classList.remove('hidden');
      moonIcon.classList.add('hidden');
    } else {
      sunIcon.classList.add('hidden');
      moonIcon.classList.remove('hidden');
    }
  }
}

export function initTheme() {
  // Move inline panels to body (they may be nested in other elements)
  document.querySelectorAll('.inline-panel').forEach((panel) => {
    if (panel.parentElement && panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
  });

  // Sync theme toggle icons with current state
  const isDark = document.documentElement.classList.contains('dark');
  const sunIcon = document.querySelector('.sun-icon');
  const moonIcon = document.querySelector('.moon-icon');
  if (sunIcon && moonIcon) {
    if (isDark) {
      sunIcon.classList.remove('hidden');
      moonIcon.classList.add('hidden');
    } else {
      sunIcon.classList.add('hidden');
      moonIcon.classList.remove('hidden');
    }
  }

  // Expose for onclick="toggleTheme()"
  window.toggleTheme = toggleTheme;
}
