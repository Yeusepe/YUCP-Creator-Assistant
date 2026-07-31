// Structured logging with JSON output, correlation IDs, and redaction
// Main entry point for the logging module

import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { recordActiveException } from '../observability';

export {
  type AuditActor,
  type AuditContext,
  type AuditEvent,
  type AuditEventType,
  type AuditSeverity,
  type AuditTarget,
  type AuditWriter,
  ConsoleAuditWriter,
  type CreateAuditEvent,
  createAuditEvent,
  createAuditHelper,
} from './audit';
export {
  type CorrelationContext,
  type CorrelationId,
  type CorrelationStorage,
  createChildSpanId,
  createCorrelationContext,
  generateCorrelationId,
  getCorrelationContext,
  runWithCorrelationContext,
  setCorrelationStorage,
} from './correlation';
export {
  isSensitiveField,
  redactEmail,
  redactForLogging,
  redactObject,
  redactString,
} from './redaction';

import { getCorrelationContext } from './correlation';
import { redactForLogging, redactString } from './redaction';

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

type LogAttributeValue = string | number | boolean;

function addFlattenedLogAttributes(
  attributes: Record<string, LogAttributeValue>,
  scope: string,
  value: unknown,
  depth = 0
): void {
  if (depth > 3 || value === undefined || value === null) {
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    attributes[`log.${scope}`] =
      typeof value === 'string' ? redactString(value).slice(0, 2_000) : value;
    return;
  }

  if (Array.isArray(value)) {
    attributes[`log.${scope}`] = redactString(JSON.stringify(value)).slice(0, 2_000);
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
      addFlattenedLogAttributes(attributes, `${scope}.${normalizedKey}`, nestedValue, depth + 1);
    }
  }
}

function buildOtelLogAttributes(entry: LogEntry): Record<string, LogAttributeValue> {
  const attributes: Record<string, LogAttributeValue> = {
    'service.name': '',
    'log.severity.text': entry.level.toUpperCase(),
    'event.name': `log.${entry.level}`,
  };
  const values = { ...entry.context, ...entry.metadata };

  addFlattenedLogAttributes(attributes, 'context', entry.context);
  addFlattenedLogAttributes(attributes, 'metadata', entry.metadata);

  const standardFields: Record<string, string> = {
    'request.id': 'requestId',
    'trace.id': 'traceId',
    'span.id': 'spanId',
    'release.id': 'releaseId',
    'app.operation.name': 'operation',
    'error.code': 'errorCode',
  };
  for (const [attributeName, fieldName] of Object.entries(standardFields)) {
    const value = values[fieldName];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[attributeName] = value;
    }
  }

  const status = values.status;
  if (typeof status === 'number') {
    attributes['http.response.status_code'] = status;
  }

  const errorValue = values.error ?? values.err;
  if (typeof errorValue === 'string') {
    attributes['exception.message'] = redactString(errorValue).slice(0, 2_000);
  }
  if (entry.level === 'error') {
    attributes['exception.type'] = 'ApplicationError';
    attributes['exception.message'] ??= entry.message;
    attributes['error.type'] = 'ApplicationError';
    attributes['error.message'] = entry.message;
  }

  return attributes;
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
    const otelAttributes = buildOtelLogAttributes(entry);
    otelAttributes['service.name'] = fullConfig.serviceName;
    if (entry.level === 'error') {
      recordActiveException(new Error(entry.message), {
        'event.name': 'exception',
        'log.severity.text': entry.level.toUpperCase(),
      });
    }

    const otelLogger = logs.getLogger(fullConfig.serviceName);
    const severityNumber =
      entry.level === 'error'
        ? SeverityNumber.ERROR
        : entry.level === 'warn'
          ? SeverityNumber.WARN
          : entry.level === 'debug'
            ? SeverityNumber.DEBUG
            : SeverityNumber.INFO;
    otelLogger.emit({
      severityNumber,
      severityText: entry.level.toUpperCase(),
      body: entry.message,
      attributes: {
        ...otelAttributes,
        ...(entry.correlationId ? { 'correlation.id': entry.correlationId } : {}),
        ...(entry.spanId ? { 'span.id': entry.spanId } : {}),
      },
    });

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
            console.error(logMessage, data);
            break;
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
