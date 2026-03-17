import { ConvexHttpClient } from 'convex/browser';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

// Convex client requires a valid URL; fail fast if env var is missing
const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) {
  throw new Error(
    'CONVEX_URL environment variable is not set. ' +
      'Please define CONVEX_URL in ../../.env before running this script.'
  );
}
const convex = new ConvexHttpClient(convexUrl);

async function test() {
  try {
    // Need a valid tenant ID to test this.
    // Let's first query a tenant ID.
    console.log('Testing updateTenantSetting mutation...');

    const apiSecret = process.env.CONVEX_API_SECRET ?? '';

    const testAuthUserId = process.env.TEST_AUTH_USER_ID;
    if (!testAuthUserId) {
      throw new Error('TEST_AUTH_USER_ID environment variable is not set.');
    }

    // We can't easily query tenant ID without knowing auth user,
    // but the mutation arguments are what we want to test for schema validation errors.
    // Cast to bypass runtime-only function reference typing in a test script
    // This is a small pragmatic change for this test helper script.
    console.log(
      // biome-ignore lint/suspicious/noExplicitAny: test helper script bypasses Convex function reference types
      await (convex as any).mutation('providerConnections:updateTenantSetting' as any, {
        apiSecret,
        authUserId: testAuthUserId,
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
