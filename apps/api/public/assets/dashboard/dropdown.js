export function initDropdowns() {
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.dropdown-wrapper') && !ev.target.closest('.dropdown-menu')) {
      document.querySelectorAll('.dropdown-menu.open').forEach((m) => {
        m.classList.remove('open');
        const btn = m.previousElementSibling;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }
  });
}
