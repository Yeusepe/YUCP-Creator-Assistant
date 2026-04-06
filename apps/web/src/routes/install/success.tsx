import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/install/success')({
  validateSearch: (search: Record<string, unknown>) => ({
    guild_id: typeof search.guild_id === 'string' ? search.guild_id : undefined,
    auth_user_id: typeof search.auth_user_id === 'string' ? search.auth_user_id : undefined,
  }),
});
