import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/verify/purchase')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent: typeof search.intent === 'string' ? search.intent : '',
    connected: typeof search.connected === 'string' ? search.connected : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Verify Purchase | YUCP' }],
  }),
});
