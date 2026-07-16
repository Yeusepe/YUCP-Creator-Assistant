export type S3ObjectLocation = {
  bucket: string;
  endpoint: string;
};

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(location: Pick<S3ObjectLocation, 'bucket'>, key?: string): string {
  const segments = [location.bucket, ...(key === undefined ? [] : key.split('/'))];
  return `/${segments.map(encodeRfc3986).join('/')}`;
}

export function buildS3ObjectUrl(location: S3ObjectLocation, key?: string): URL {
  const url = new URL(location.endpoint);
  url.pathname = canonicalPath(location, key);
  return url;
}
