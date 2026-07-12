/**
 * Purpose: Centralizes API request body limits for large Backstage package uploads.
 * Governing docs:
 * - docs/review-playbook.md
 * - README.md
 * External references:
 * - https://bun.sh/reference/bun/Serve/maxRequestBodySize
 * Tests:
 * - apps/api/src/lib/requestBodyLimits.test.ts
 */

import { MAX_BACKSTAGE_PACKAGE_BYTES } from '@yucp/shared/backstageLimits';

export const MAX_BACKSTAGE_UPLOAD_BYTES = 1024 * 1024 * 1024;
export { MAX_BACKSTAGE_PACKAGE_BYTES };
