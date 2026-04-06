export const JINXXY_PENDING_WEBHOOK_TTL_MS = 30 * 60 * 1000;
export const JINXXY_TEST_TTL_MS = 60 * 1000;

const JINXXY_PENDING_WEBHOOK_PREFIX = 'jinxxy_webhook_pending:';
const JINXXY_PENDING_WEBHOOK_TOKEN_PREFIX = 'jinxxy_webhook_pending_token:';
const JINXXY_TEST_PREFIX = 'jinxxy_test:';

export function getPendingJinxxyWebhookStoreKey(authUserId: string): string {
  return `${JINXXY_PENDING_WEBHOOK_PREFIX}${authUserId}`;
}

export function getPendingJinxxyWebhookTokenStoreKey(routeToken: string): string {
  return `${JINXXY_PENDING_WEBHOOK_TOKEN_PREFIX}${routeToken}`;
}

export function getJinxxyWebhookTestStoreKey(routeId: string): string {
  return `${JINXXY_TEST_PREFIX}${routeId}`;
}
