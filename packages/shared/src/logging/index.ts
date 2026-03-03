// Structured logging with JSON output, correlation IDs, and redaction
// Main entry point for the logging module

export {
  generateCorrelationId,
  createCorrelationContext,
  getCorrelationContext,
  runWithCorrelationContext,
  createChildSpanId,
  setCorrelationStorage,
  type CorrelationContext,
  type CorrelationId,
  type CorrelationStorage,
} from './correlation';

export {
  redactString,
  redactEmail,
  redactObject,
  redactForLogging,
  isSensitiveField,
} from './redaction';

export {
  createAuditEvent,
  ConsoleAuditWriter,
  createAuditHelper,
  type AuditEvent,
  type AuditEventType,
  type AuditSeverity,
  type AuditActor,
  type AuditTarget,
  type AuditContext,
  type AuditWriter,
  type CreateAuditEvent,
} from './audit';

import { type CorrelationContext, getCorrelationContext } from './correlation';
import { redactForLogging } from './redaction';

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  spanId?: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: LogLevel;
  serviceName: string;
  jsonOutput: boolean;
  includeCorrelation: boolean;
  redactSensitive: boolean;
  /** Optional sink for tests; when set, log entries are sent here instead of console */
  sink?: (entry: LogEntry) => void;
  /** Optional initial context (used by child loggers) */
  _context?: Record<string, unknown>;
}

/**
 * Structured logger with JSON output
 */
export interface StructuredLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(additionalContext: Record<string, unknown>): StructuredLogger;
}

/**
 * Create a structured logger
 */
export function createStructuredLogger(config: Partial<LoggerConfig> = {}): StructuredLogger {
  const fullConfig: LoggerConfig = {
    level: (config.level as LogLevel) || 'info',
    serviceName: config.serviceName || 'app',
    jsonOutput: config.jsonOutput ?? true,
    includeCorrelation: config.includeCorrelation ?? true,
    redactSensitive: config.redactSensitive ?? true,
    sink: config.sink,
    _context: config._context,
  };

  const context: Record<string, unknown> = config._context ?? {};

  function shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return levels[level] >= levels[fullConfig.level];
  }

  function buildEntry(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEntry {
    const correlationContext = fullConfig.includeCorrelation ? getCorrelationContext() : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: fullConfig.redactSensitive ? redactForLogging(message) : message,
      correlationId: correlationContext?.correlationId,
      spanId: correlationContext?.spanId,
    };

    if (Object.keys(context).length > 0) {
      entry.context = fullConfig.redactSensitive ? redactForLogging(context) : context;
    }

    if (meta && Object.keys(meta).length > 0) {
      entry.metadata = fullConfig.redactSensitive ? redactForLogging(meta) : meta;
    }

    return entry;
  }

  function output(entry: LogEntry): void {
    if (fullConfig.sink) {
      fullConfig.sink(entry);
      return;
    }
    if (fullConfig.jsonOutput) {
      const logLine = JSON.stringify(entry);
      switch (entry.level) {
        case 'error':
          console.error(logLine);
          break;
        case 'warn':
          console.warn(logLine);
          break;
        default:
          console.log(logLine);
      }
    } else {
      // Human-readable format
      const parts = [
        `[${entry.timestamp}]`,
        `[${entry.level.toUpperCase()}]`,
        `[${fullConfig.serviceName}]`,
        entry.correlationId ? `[corr:${entry.correlationId}]` : '',
        entry.message,
      ].filter(Boolean);

      const logMessage = parts.join(' ');

      if (entry.context || entry.metadata) {
        const data = { ...entry.context, ...entry.metadata };
        switch (entry.level) {
          case 'error':
          case 'warn':
            console.warn(logMessage, data);
            break;
          default:
            console.log(logMessage, data);
        }
      } else {
        switch (entry.level) {
          case 'error':
            console.error(logMessage);
            break;
          case 'warn':
            console.warn(logMessage);
            break;
          default:
            console.log(logMessage);
        }
      }
    }
  }

  return {
    debug(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('debug')) {
        output(buildEntry('debug', message, meta));
      }
    },

    info(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('info')) {
        output(buildEntry('info', message, meta));
      }
    },

    warn(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('warn')) {
        output(buildEntry('warn', message, meta));
      }
    },

    error(message: string, meta?: Record<string, unknown>): void {
      if (shouldLog('error')) {
        output(buildEntry('error', message, meta));
      }
    },

    child(additionalContext: Record<string, unknown>): StructuredLogger {
      const childContext = { ...context, ...additionalContext };
      return createStructuredLogger({
        ...fullConfig,
        _context: childContext,
      });
    },
  };
}

// Re-export the original createLogger for backward compatibility
export function createLogger(level = 'info') {
  return createStructuredLogger({
    level: level as LogLevel,
    jsonOutput: false,
    includeCorrelation: false,
    redactSensitive: true,
  });
}
