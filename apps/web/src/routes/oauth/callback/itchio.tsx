import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/oauth/callback/itchio')({
  head: () => ({
    meta: [{ title: 'itch.io OAuth Callback | Creator Assistant' }],
  }),
});
