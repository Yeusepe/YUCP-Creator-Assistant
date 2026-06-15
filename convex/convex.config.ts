// Workpool component docs: https://www.convex.dev/components/workpool
import workpool from '@convex-dev/workpool/convex.config';
import { defineApp } from 'convex/server';
import betterAuth from './betterAuth/convex.config';

const app: ReturnType<typeof defineApp> = defineApp();
app.use(betterAuth);
// Durable, retrying execution of Discord role_sync / role_removal jobs.
app.use(workpool, { name: 'roleSyncPool' });

export default app;
