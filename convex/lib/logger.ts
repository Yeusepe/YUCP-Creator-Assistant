import { redactForLogging } from '../../packages/shared/src/logging/redaction';

type ConvexLogLevel = 'info' | 'warn' | 'error';

function log(level: ConvexLogLevel, message: string, metadata?: Record<string, unknown>): void {
  const safeMessage = redactForLogging(message);
  const safeMetadata = metadata ? redactForLogging(metadata) : undefined;

  switch (level) {
    case 'error':
      if (safeMetadata) {
        console.error(safeMessage, safeMetadata);
      } else {
        console.error(safeMessage);
      }
      return;
    case 'warn':
      if (safeMetadata) {
        console.warn(safeMessage, safeMetadata);
      } else {
        console.warn(safeMessage);
      }
      return;
    default:
      if (safeMetadata) {
        console.log(safeMessage, safeMetadata);
      } else {
        console.log(safeMessage);
      }
  }
}

export interface ConvexLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export function createConvexLogger(): ConvexLogger {
  return {
    info(message, metadata) {
      log('info', message, metadata);
    },
    warn(message, metadata) {
      log('warn', message, metadata);
    },
    error(message, metadata) {
      log('error', message, metadata);
    },
  };
}
