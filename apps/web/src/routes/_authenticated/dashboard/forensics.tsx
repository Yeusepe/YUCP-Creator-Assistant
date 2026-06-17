import { createFileRoute, redirect } from '@tanstack/react-router';

// Coupling forensics is now a view inside the private VPM package workspace.
// Keep this path as a redirect for the Discord bot link and any existing deep links.
export const Route = createFileRoute('/_authenticated/dashboard/forensics')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard/packages', search: { view: 'forensics' }, replace: true });
  },
});
