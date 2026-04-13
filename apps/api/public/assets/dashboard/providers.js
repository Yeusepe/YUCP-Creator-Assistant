let cachedProviders = [];
let loadPromise = null;

/**
 * Fetch the provider list from the API and cache it.
 * Safe to call multiple times, returns the same in-flight Promise on concurrent calls.
 */
export async function loadProviders(apiBase) {
  if (cachedProviders.length > 0) return cachedProviders;
  if (!loadPromise) {
    loadPromise = fetch(`${apiBase}/api/providers`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        cachedProviders = data;
        return data;
      })
      .catch((err) => {
        loadPromise = null;
        console.error('Failed to load providers:', err);
        return [];
      });
  }
  return loadPromise;
}

export function getActiveSetupProviders() {
  return cachedProviders;
}

export function getDashboardProvider(providerKey) {
  return cachedProviders.find((p) => p.key === providerKey) ?? null;
}

