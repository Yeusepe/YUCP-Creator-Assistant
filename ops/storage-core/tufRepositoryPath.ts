const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export type TufRepositoryRole = 'metadata' | 'targets';

export type TufRepositoryRoutePath = {
  repositoryPath: string;
  role: TufRepositoryRole;
};

export function normalizeTufRepositoryPath(value: string): string | null {
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\0')
  ) {
    return null;
  }
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    return null;
  }
  return segments.join('/');
}

export function parseTufRepositoryRoutePath(
  pathname: string,
  prefix: string
): TufRepositoryRoutePath | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf('/');
  if (separator < 1) {
    return null;
  }
  const role = remainder.slice(0, separator);
  if (role !== 'metadata' && role !== 'targets') {
    return null;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(remainder.slice(separator + 1));
  } catch {
    return null;
  }
  const repositoryPath = normalizeTufRepositoryPath(decodedPath);
  return repositoryPath ? { repositoryPath, role } : null;
}
