import { useConvexAuth, useMutation as useConvexMutation } from 'convex/react';
import { useEffect } from 'react';
import { api } from '../../../../../convex/_generated/api';
import { PRIVACY_PREFERENCES_EVENT, type PrivacyPreferences } from '@/lib/privacyPreferences';

/**
 * Records a signed-in buyer's banner choice. This lives inside the authenticated
 * tree because it needs the Convex auth provider, while the banner itself renders
 * on public routes that have none.
 */
export function PrivacyConsentSync() {
  const { isAuthenticated } = useConvexAuth();
  const recordConsent = useConvexMutation(api.accountDiagnosticsConsent.recordConsent);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    function handlePreferences(event: Event) {
      const detail = (event as CustomEvent<PrivacyPreferences>).detail;
      if (!detail || detail.source !== 'banner') {
        return;
      }
      void recordConsent({
        choice: detail.choice,
        source: 'banner',
        ...(detail.diagnosticsSessionId
          ? { diagnosticsSessionId: detail.diagnosticsSessionId }
          : {}),
      }).catch(() => undefined);
    }

    window.addEventListener(PRIVACY_PREFERENCES_EVENT, handlePreferences);
    return () => {
      window.removeEventListener(PRIVACY_PREFERENCES_EVENT, handlePreferences);
    };
  }, [isAuthenticated, recordConsent]);

  return null;
}
