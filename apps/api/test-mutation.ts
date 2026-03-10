import { ConvexHttpClient } from 'convex/browser';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { anyApi } from 'convex/server';

// Convex client requires a string URL; guard against undefined env var
const convex = new ConvexHttpClient(process.env.CONVEX_URL ?? '');

async function test() {
  try {
    // Need a valid tenant ID to test this.
    // Let's first query a tenant ID.
    console.log('Testing updateTenantSetting mutation...');

    const apiSecret = process.env.CONVEX_API_SECRET ?? '';

    // We can't easily query tenant ID without knowing auth user,
    // but the mutation arguments are what we want to test for schema validation errors.
    // Cast to any to bypass runtime-only function reference typing in a test script
    // This is a small pragmatic change for this test helper script.
    console.log(
      await (convex as any).mutation('providerConnections:updateTenantSetting' as any, {
        apiSecret,
        tenantId: 'kd70v9q3g218hbgxykrt2cxsv978rth0',
        key: 'allowMismatchedEmails',
        value: true,
      })
    );
  } catch (err) {
    console.error('Mutation failed:');
    console.error(err);
  }
}

test();
