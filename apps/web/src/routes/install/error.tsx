import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/install/error')({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === 'string' ? search.error : 'unknown',
  }),
});
