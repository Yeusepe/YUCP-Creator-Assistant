/**
 * API URL resolution for bot → API communication.
 *
 * - apiInternal: For server-to-server fetch() calls. Use Zeabur private hostname when set for faster, in-network traffic.
 * - apiPublic: For user-facing links (connect, verify, etc.). Must be the public URL since users open these in their browser.
 */

export function getApiUrls(): { apiInternal: string | undefined; apiPublic: string | undefined } {
  const apiPublic = process.env.API_BASE_URL;
  const apiInternal = process.env.API_INTERNAL_URL ?? apiPublic;
  return { apiInternal, apiPublic };
}
