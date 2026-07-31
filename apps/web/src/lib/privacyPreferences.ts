export const PRIVACY_PREFERENCES_STORAGE_KEY = 'yucp_privacy_preferences';
export const PRIVACY_PREFERENCES_COOKIE = 'yucp_privacy_preferences';
export const PRIVACY_PREFERENCES_EVENT = 'yucp:privacy-preferences-changed';
export const DIAGNOSTICS_SESSION_HEADER = 'X-YUCP-Diagnostics-Session';
const PRIVACY_PREFERENCES_VERSION = 1;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export type PrivacyPreferenceSource = 'banner' | 'account';
export type PrivacyPreferenceChoice = 'necessary-only' | 'helpful-diagnostics';

export interface PrivacyPreferences {
  version: 1;
  choice: PrivacyPreferenceChoice;
  diagnosticsEnabled: boolean;
  diagnosticsSessionId: string | null;
  source: PrivacyPreferenceSource;
  updatedAt: number;
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function createDiagnosticsSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `diag-${Date.now().toString(36)}-${performance.now().toFixed(0)}`;
}

function normalizePreferences(value: unknown): PrivacyPreferences | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const choice = record.choice;
  const diagnosticsEnabled = record.diagnosticsEnabled;
  const diagnosticsSessionId = record.diagnosticsSessionId;
  const source = record.source;
  const updatedAt = record.updatedAt;

  if (choice !== 'necessary-only' && choice !== 'helpful-diagnostics') {
    return null;
  }

  if (typeof diagnosticsEnabled !== 'boolean') {
    return null;
  }

  if (
    diagnosticsSessionId !== null &&
    diagnosticsSessionId !== undefined &&
    typeof diagnosticsSessionId !== 'string'
  ) {
    return null;
  }

  if (source !== 'banner' && source !== 'account') {
    return null;
  }

  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return null;
  }

  return {
    version: PRIVACY_PREFERENCES_VERSION,
    choice,
    diagnosticsEnabled,
    diagnosticsSessionId:
      choice === 'helpful-diagnostics'
        ? typeof diagnosticsSessionId === 'string' && diagnosticsSessionId.trim()
          ? diagnosticsSessionId
          : createDiagnosticsSessionId()
        : null,
    source,
    updatedAt,
  };
}

export function serializePrivacyPreferences(preferences: PrivacyPreferences) {
  return JSON.stringify(preferences);
}

export function parsePrivacyPreferences(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }

  try {
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function buildPrivacyPreferences(
  choice: PrivacyPreferenceChoice,
  source: PrivacyPreferenceSource
): PrivacyPreferences {
  const diagnosticsEnabled = choice === 'helpful-diagnostics';
  return {
    version: PRIVACY_PREFERENCES_VERSION,
    choice,
    diagnosticsEnabled,
    diagnosticsSessionId: diagnosticsEnabled ? createDiagnosticsSessionId() : null,
    source,
    updatedAt: Date.now(),
  };
}

function getCookieValue(cookieString: string, name: string) {
  const segments = cookieString.split(';');
  for (const segment of segments) {
    const [rawName, ...rest] = segment.trim().split('=');
    if (rawName === name) {
      return rest.join('=');
    }
  }
  return null;
}

function decodeStoredPrivacyPreferences(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function readStoredPrivacyPreferences() {
  if (!isBrowser()) {
    return null;
  }

  const fromStorage = parsePrivacyPreferences(
    window.localStorage.getItem(PRIVACY_PREFERENCES_STORAGE_KEY)
  );
  if (fromStorage) {
    return fromStorage;
  }

  const fromCookie = parsePrivacyPreferences(
    decodeStoredPrivacyPreferences(getCookieValue(document.cookie, PRIVACY_PREFERENCES_COOKIE))
  );
  if (!fromCookie) {
    return null;
  }

  window.localStorage.setItem(
    PRIVACY_PREFERENCES_STORAGE_KEY,
    serializePrivacyPreferences(fromCookie)
  );
  return fromCookie;
}

export function getDiagnosticsRequestHeaders(): Record<string, string> {
  const preferences = readStoredPrivacyPreferences();
  const sessionId = preferences?.diagnosticsEnabled
    ? preferences.diagnosticsSessionId?.trim()
    : undefined;

  return sessionId ? { [DIAGNOSTICS_SESSION_HEADER]: sessionId } : {};
}

function writeCookie(value: string) {
  const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: This first-party cookie persists the user's consent choice across reloads and SSR boundaries.
  document.cookie = `${PRIVACY_PREFERENCES_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureFlag}`;
}

export function savePrivacyPreferences(
  choice: PrivacyPreferenceChoice,
  source: PrivacyPreferenceSource
) {
  if (!isBrowser()) {
    return buildPrivacyPreferences(choice, source);
  }

  const preferences = buildPrivacyPreferences(choice, source);
  const serialized = serializePrivacyPreferences(preferences);
  window.localStorage.setItem(PRIVACY_PREFERENCES_STORAGE_KEY, serialized);
  writeCookie(serialized);
  window.dispatchEvent(
    new CustomEvent(PRIVACY_PREFERENCES_EVENT, {
      detail: preferences,
    })
  );
  return preferences;
}

export function getPrivacyPreferenceSummary(preferences: PrivacyPreferences | null) {
  if (!preferences) {
    return {
      title: 'Not chosen yet',
      description:
        'We only use necessary cookies until you choose whether helpful diagnostics can be enabled.',
    };
  }

  if (!preferences.diagnosticsEnabled) {
    return {
      title: 'Necessary cookies only',
      description:
        'Only essential first-party cookies and storage are active. Optional diagnostics and replay stay off.',
    };
  }

  return {
    title: 'Helpful diagnostics enabled',
    description:
      'Optional diagnostics can help debug slow pages and bugs with anonymous error, performance, and replay data.',
  };
}
