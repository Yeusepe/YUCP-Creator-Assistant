import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/account/verify')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent: typeof search.intent === 'string' ? search.intent : '',
  }),
});
