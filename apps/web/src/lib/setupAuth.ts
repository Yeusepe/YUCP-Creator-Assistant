export function buildSetupAuthQuery(path: string, authUserId: string | null | undefined) {
  if (!authUserId) {
    return path;
  }

  const url = new URL(path, 'http://localhost');
  url.searchParams.set('authUserId', authUserId);
  return `${url.pathname}${url.search}`;
}

export function withSetupAuthUserId<T extends Record<string, string>>(
  body: T,
  authUserId: string | null | undefined
) {
  if (!authUserId) {
    return body;
  }

  return {
    ...body,
    authUserId,
  };
}
