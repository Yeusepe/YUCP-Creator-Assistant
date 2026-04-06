/**
 * Application-level logger singleton for apps/api.
 *
 * All modules in this app import `logger` from here instead of calling
 * createLogger(process.env.LOG_LEVEL ?? 'info') individually.
 * To change log level, format, or add a sink for the entire API, edit this file.
 */

import { createLogger, type StructuredLogger } from '@yucp/shared';

export const logger: StructuredLogger = createLogger(process.env.LOG_LEVEL ?? 'info');
