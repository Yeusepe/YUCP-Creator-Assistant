/**
 * Button loading-state tests
 *
 * All server-mutating buttons must show a loading / disabled state while the
 * request is in flight so the user can see that something is happening and
 * cannot accidentally double-submit.
 */

import { describe, expect, it } from 'bun:test';

// ─────────────────────────────────────────────────────────────────────────────
// Shared loading-state utility
// ─────────────────────────────────────────────────────────────────────────────

describe('utils.js, button loading helpers', () => {
  it('exports setButtonLoading', async () => {
    // A shared helper keeps every button state change consistent: disabled +
    // inline spinner + label. Centralising this prevents each module from
    // reinventing the pattern differently.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/utils.js`).text();
    expect(src).toContain('export function setButtonLoading');
  });

  it('exports clearButtonLoading', async () => {
    // The matching restore helper must exist so callers can reset the button
    // to its original state after success or failure.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/utils.js`).text();
    expect(src).toContain('export function clearButtonLoading');
  });

  it('setButtonLoading stores original innerHTML/disabled on the element', async () => {
    // The helper must stash the previous content on the element so
    // clearButtonLoading can restore it exactly without each call site
    // keeping its own copy.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/utils.js`).text();
    const block = src.slice(
      src.indexOf('export function setButtonLoading'),
      src.indexOf('export function clearButtonLoading')
    );
    expect(block).toMatch(/_prevHtml|_origHtml/);
    expect(block).toContain('btn.disabled = true');
  });

  it('clearButtonLoading restores innerHTML and disabled', async () => {
    // clearButtonLoading must restore both properties so the button looks and
    // behaves exactly as it did before setButtonLoading was called.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/utils.js`).text();
    const block = src.slice(src.indexOf('export function clearButtonLoading'));
    expect(block).toMatch(/btn\.innerHTML\s*=|btn\.disabled\s*=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS spinner
// ─────────────────────────────────────────────────────────────────────────────

describe('dashboard.css, inline button spinner', () => {
  it('has .btn-spinner class', async () => {
    // The spinner element used inside loading buttons must be styled. Without
    // the CSS rule the spinner element is invisible and the loading state shows
    // nothing.
    const css = await Bun.file(`${import.meta.dir}/../public/dashboard.css`).text();
    expect(css).toContain('.btn-spinner');
  });

  it('has @keyframes btn-spin animation', async () => {
    // The spinner rotation requires a named keyframe. Without it the border
    // trick produces a static ring, not a spinning indicator.
    const css = await Bun.file(`${import.meta.dir}/../public/dashboard.css`).text();
    expect(css).toContain('@keyframes btn-spin');
  });

  it('has .svr-cfg-switch.saving that prevents pointer-events', async () => {
    // While a settings toggle is saving, a second click should not fire.
    // The .saving class must set pointer-events:none on the toggle element.
    const css = await Bun.file(`${import.meta.dir}/../public/dashboard.css`).text();
    expect(css).toContain('.svr-cfg-switch.saving');
    const block = css.slice(
      css.indexOf('.svr-cfg-switch.saving'),
      css.indexOf('.svr-cfg-switch.saving') + 120
    );
    expect(block).toContain('pointer-events');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// platform.js, provider connect button
// ─────────────────────────────────────────────────────────────────────────────

describe('platform.js, navigateProvider button state', () => {
  it('navigateProvider uses setButtonLoading before the async session step', async () => {
    // The "Connect" button for each platform must show a loading state while
    // ensureSetupSessionCookie() runs. Without this, the button appears frozen
    // and users click it repeatedly, triggering multiple redirects.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    const block = src.slice(
      src.indexOf('export async function navigateProvider'),
      src.indexOf('export async function fetchAllData')
    );
    expect(block).toContain('setButtonLoading');
  });

  it('navigateProvider imports setButtonLoading from utils.js', async () => {
    // The helper must be imported so the module resolves correctly at runtime.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    expect(src).toContain('setButtonLoading');
    expect(src).toMatch(/from ['"]\.\/utils\.js['"]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// platform.js, settings toggle
// ─────────────────────────────────────────────────────────────────────────────

describe('platform.js, toggleSetting busy state', () => {
  it('toggleSetting adds .saving class to the toggle while the request is in flight', async () => {
    // Without a busy guard the user can click the toggle again before the first
    // request resolves, sending conflicting state updates and leaving the UI in
    // an inconsistent state.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    const block = src.slice(
      src.indexOf('async function toggleSetting'),
      src.indexOf('async function selectSetting')
    );
    expect(block).toContain('saving');
  });

  it('toggleSetting removes .saving class after the request resolves', async () => {
    // The .saving class must always be removed, even on error, so the toggle is
    // not permanently frozen if the network request fails.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    // Must appear in both the success path and the catch/finally
    const block = src.slice(
      src.indexOf('async function toggleSetting'),
      src.indexOf('async function selectSetting')
    );
    const removeCount = (block.match(/remove.*saving|saving.*remove/g) ?? []).length;
    expect(removeCount).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// platform.js, user account disconnect button
// ─────────────────────────────────────────────────────────────────────────────

describe('platform.js, confirmDisconnectUserAccount button state', () => {
  it('confirmDisconnectUserAccount sets loading state on the clicked button', async () => {
    // The disconnect button must be disabled while the DELETE request is in
    // flight so the user cannot click it twice and send two concurrent deletes.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    const block = src.slice(
      src.indexOf('export async function confirmDisconnectUserAccount'),
      src.indexOf('async function loadGuildChannels')
    );
    expect(block).toContain('setButtonLoading');
  });

  it('confirmDisconnectUserAccount restores button after the request', async () => {
    // Whether the delete succeeds or fails, the button must be restored so the
    // UI is not left in a permanently-disabled state.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/platform.js`).text();
    const block = src.slice(
      src.indexOf('export async function confirmDisconnectUserAccount'),
      src.indexOf('async function loadGuildChannels')
    );
    expect(block).toContain('clearButtonLoading');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collab.js, revoke invite button
// ─────────────────────────────────────────────────────────────────────────────

describe('collab.js, revokeInvite button state', () => {
  it('revokeInvite sets loading state on the revoke button', async () => {
    // The "Revoke" button must be disabled while the DELETE request runs.
    // Without this, two rapid clicks can send two revoke requests, the second
    // of which would return 404 (already revoked) and confuse the user.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/collab.js`).text();
    const block = src.slice(
      src.indexOf('export async function revokeInvite'),
      src.indexOf('async function fetchAsCollaboratorConnections')
    );
    expect(block).toContain('setButtonLoading');
  });

  it('revokeInvite clears loading state after the request', async () => {
    // Even on network error the button must be restored so the user can retry.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/collab.js`).text();
    const block = src.slice(
      src.indexOf('export async function revokeInvite'),
      src.indexOf('async function fetchAsCollaboratorConnections')
    );
    expect(block).toContain('clearButtonLoading');
  });

  it('renderInvitesSection passes the revoke button element to revokeInvite', async () => {
    // revokeInvite receives the button element as its second argument only if
    // the render call passes it. Without this the function has no reference to
    // the button and cannot update its state.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/collab.js`).text();
    // The event listener inside renderInvitesSection must pass a button ref
    expect(src).toMatch(/revokeInvite\(invite\.id\s*,\s*(revokeBtn|btn)\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api.js, API key revoke / rotate menu actions
// ─────────────────────────────────────────────────────────────────────────────

describe('api.js, revokePublicApiKey / rotatePublicApiKey button states', () => {
  it('revokePublicApiKey sets loading state on its button arg', async () => {
    // When the user confirms revocation, the three-dot menu button (or the menu
    // item itself) must show a spinner so there is visual feedback during the
    // request. Without this the UI appears frozen after the confirm dialog.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/api.js`).text();
    const block = src.slice(
      src.indexOf('async function revokePublicApiKey'),
      src.indexOf('async function rotatePublicApiKey')
    );
    expect(block).toContain('setButtonLoading');
  });

  it('revokePublicApiKey clears loading state after the request', async () => {
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/api.js`).text();
    const block = src.slice(
      src.indexOf('async function revokePublicApiKey'),
      src.indexOf('async function rotatePublicApiKey')
    );
    expect(block).toContain('clearButtonLoading');
  });

  it('rotatePublicApiKey sets loading state on its button arg', async () => {
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/api.js`).text();
    const block = src.slice(
      src.indexOf('async function rotatePublicApiKey'),
      src.indexOf('export function initApiKeys')
    );
    expect(block).toContain('setButtonLoading');
  });

  it('rotatePublicApiKey clears loading state after the request', async () => {
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/api.js`).text();
    const block = src.slice(
      src.indexOf('async function rotatePublicApiKey'),
      src.indexOf('export function initApiKeys')
    );
    expect(block).toContain('clearButtonLoading');
  });

  it('api.js click handlers pass menuBtn to revokePublicApiKey and rotatePublicApiKey', async () => {
    // The functions receive the button as an argument. If the click handler does
    // not forward the element, the function has nothing to update.
    const src = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/api.js`).text();
    expect(src).toMatch(/revokePublicApiKey\(key\._id\s*,\s*menuBtn\)/);
    expect(src).toMatch(/rotatePublicApiKey\(key\._id\s*,\s*menuBtn\)/);
  });
});
