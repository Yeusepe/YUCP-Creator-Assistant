/**
 * API URL resolution for bot → API communication.
 *
 * - apiInternal: For server-to-server fetch() calls. Use Zeabur private hostname when set for faster, in-network traffic.
 * - apiPublic: Public API origin used for bot -> API HTTP requests when no internal URL exists.
 * - webPublic: User-facing frontend origin for links users open in their browser.
 */

export function getApiUrls(): {
  apiInternal: string | undefined;
  apiPublic: string | undefined;
  webPublic: string | undefined;
} {
  const apiPublic = process.env.API_BASE_URL;
  const apiInternal = process.env.API_INTERNAL_URL ?? apiPublic;
  const webPublic = process.env.FRONTEND_URL ?? process.env.VERIFY_BASE_URL ?? apiPublic;
  return { apiInternal, apiPublic, webPublic };
}
