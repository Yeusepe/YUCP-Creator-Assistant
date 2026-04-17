import { createServerFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/react-start/server';
import { withWebServerRequestSpan } from './observability';

export const getDocumentRequestUrl = createServerFn({ method: 'GET' }).handler(async () => {
  return withWebServerRequestSpan(
    'serverFn.runtime-config.request-url',
    {
      'tanstack.serverfn': 'getDocumentRequestUrl',
    },
    async () =>
      getRequestUrl({
        xForwardedHost: true,
        xForwardedProto: true,
      }).toString()
  );
});
