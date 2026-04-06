import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/setup/lemonsqueezy')({
  head: () => ({
    meta: [{ title: 'Connect Lemon Squeezy® | Creator Assistant' }],
  }),
});
