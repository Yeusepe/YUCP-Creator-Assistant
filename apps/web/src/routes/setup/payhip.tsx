import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/setup/payhip')({
  head: () => ({
    meta: [{ title: 'Connect Payhip | Creator Assistant' }],
  }),
});
