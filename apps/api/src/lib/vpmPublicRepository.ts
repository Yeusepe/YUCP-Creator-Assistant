export interface PublicVpmRepositoryAccess {
  addRepoUrl: string;
  indexUrl: string;
}

/**
 * Build the persistent VPM source for one creator-managed product repository.
 *
 * Repository contract: https://vcc.docs.vrchat.com/vpm/repos/
 * VPM CLI contract: https://vcc.docs.vrchat.com/vpm/cli/
 */
export function buildPublicVpmRepositoryAccess(
  vpmBaseUrl: string,
  linkId: string
): PublicVpmRepositoryAccess {
  const indexUrl = new URL(
    `/api/vpm/access/${encodeURIComponent(linkId)}/index.json`,
    vpmBaseUrl
  ).toString();
  const addRepoUrl = new URL('vcc://vpm/addRepo');
  addRepoUrl.searchParams.set('url', indexUrl);
  return {
    addRepoUrl: addRepoUrl.toString(),
    indexUrl,
  };
}
