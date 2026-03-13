export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function copyText(text, triggerEl, successLabel) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (triggerEl) {
      const prev = triggerEl.innerHTML;
      if (successLabel) {
        triggerEl.textContent = successLabel;
      } else {
        triggerEl.innerHTML = '';
        triggerEl.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`);
      }
      setTimeout(() => {
        triggerEl.innerHTML = prev;
      }, 2000);
    }
  } catch {
    /* silent */
  }
}
