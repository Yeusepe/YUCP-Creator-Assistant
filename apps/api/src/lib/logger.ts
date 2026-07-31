/**
 * Application-level logger singleton for apps/api.
 *
 * All modules in this app import `logger` from here instead of calling
 * createLogger(process.env.LOG_LEVEL ?? 'info') individually.
 * To change log level, format, or add a sink for the entire API, edit this file.
 */

import { createStructuredLogger, type StructuredLogger } from '@yucp/shared';

export const logger: StructuredLogger = createStructuredLogger({
  level: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  serviceName: 'yucp-api',
  jsonOutput: false,
  includeCorrelation: false,
  redactSensitive: true,
});
