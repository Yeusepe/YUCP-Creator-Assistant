import { createLazyFileRoute } from '@tanstack/react-router';
export const Route = createLazyFileRoute('/_authenticated/account/certificates')({
  component: () => null,
});
