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

/**
 * Sets a button into a loading state: disabled + inline spinner + label.
 * Stashes the original innerHTML and disabled state on the element so
 * clearButtonLoading can restore them exactly.
 * @param {HTMLButtonElement|null} btn
 * @param {string} [label] - Optional text to show next to the spinner
 */
export function setButtonLoading(btn, label = '') {
  if (!btn) return;
  btn._prevHtml = btn.innerHTML;
  btn._prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = label
    ? `<span class="btn-spinner"></span><span>${label}</span>`
    : '<span class="btn-spinner"></span>';
}

/**
 * Restores a button that was previously set into a loading state by
 * setButtonLoading, re-enabling it and restoring its original content.
 * @param {HTMLButtonElement|null} btn
 */
export function clearButtonLoading(btn) {
  if (!btn) return;
  btn.disabled = btn._prevDisabled ?? false;
  btn.innerHTML = btn._prevHtml ?? '';
  delete btn._prevHtml;
  delete btn._prevDisabled;
}
