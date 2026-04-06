import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/setup/vrchat')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string) || '',
    mode: (search.mode as string) || '',
    guild_id: (search.guild_id as string) || '',
    tenant_id: (search.tenant_id as string) || '',
    returnUrl: (search.returnUrl as string) || '',
  }),
  head: () => ({
    meta: [{ title: 'Verify with VRChat | Creator Assistant' }],
  }),
});
