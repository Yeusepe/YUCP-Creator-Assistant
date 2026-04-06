import { createContext, useContext } from 'react';

/** Per-page context that becomes `true` once that page's cloud background is ready. */
export const CloudReadyContext = createContext(false);

/** Returns `true` once the current page's cloud background is ready to display. */
export function useCloudReady() {
  return useContext(CloudReadyContext);
}
