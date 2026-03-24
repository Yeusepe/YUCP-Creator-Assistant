import { createContext, useContext } from 'react';

/**
 * Context that becomes `true` once the singleton CloudBackground in the root
 * layout has fired its `onReady` callback. Pages that gate their content reveal
 * behind the background being visible can read this context instead of
 * mounting their own BackgroundCanvasRoot.
 */
export const CloudReadyContext = createContext(false);

/** Returns `true` once the root-level cloud background is ready to display. */
export function useCloudReady() {
  return useContext(CloudReadyContext);
}
