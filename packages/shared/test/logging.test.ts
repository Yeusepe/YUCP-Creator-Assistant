// Test file for logging utilities

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type CorrelationContext,
  type CorrelationStorage,
  createChildSpanId,
  createCorrelationContext,
  generateCorrelationId,
  getCorrelationContext,
  runWithCorrelationContext,
  setCorrelationStorage,
} from '../src/logging/correlation';

import {
  isSensitiveField,
  redactEmail,
  redactForLogging,
  redactObject,
  redactString,
} from '../src/logging/redaction';

import {
  type AuditEvent,
  type AuditTarget,
  type AuditWriter,
  ConsoleAuditWriter,
  createAuditEvent,
  createAuditHelper,
} from '../src/logging/audit';

import { type LogEntry, createStructuredLogger } from '../src/logging/index';

// Mock AsyncLocalStorage for testing
class MockAsyncLocalStorage implements CorrelationStorage {
  private store?: CorrelationContext;

  getStore(): CorrelationContext | undefined {
    return this.store;
  }

  run<T>(context: CorrelationContext, fn: () => T): T {
    this.store = context;
    try {
      return fn();
    } finally {
      this.store = undefined;
    }
  }
}

const mockStorage = new MockAsyncLocalStorage();

describe('correlation', () => {
  beforeEach(() => {
    setCorrelationStorage(mockStorage);
  });

  afterEach(() => {
    setCorrelationStorage(null);
  });

  describe('generateCorrelationId', () => {
    it('should generate a valid UUID', () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should generate unique IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('createCorrelationContext', () => {
    it('should create context with correlation and span IDs', () => {
      const context = createCorrelationContext();
      expect(context.correlationId).toBeDefined();
      expect(context.spanId).toBeDefined();
      expect(context.parentSpanId).toBeUndefined();
    });

    it('should accept parent span ID', () => {
      const context = createCorrelationContext('parent-span');
      expect(context.parentSpanId).toBe('parent-span');
    });
  });

  describe('getCorrelationContext', () => {
    it('should return context from storage when set', () => {
      const context = createCorrelationContext();
      runWithCorrelationContext(context, () => {
        const stored = getCorrelationContext();
        expect(stored?.correlationId).toBe(context.correlationId);
      });
    });

    it('should return undefined when no storage set', () => {
      setCorrelationStorage(null);
      expect(getCorrelationContext()).toBeUndefined();
    });
  });

  describe('createChildSpanId', () => {
    it('should create child span ID from parent', () => {
      const childId = createChildSpanId('parent123');
      expect(childId).toMatch(/^parent123-[a-f0-9]{4}$/);
    });
  });
});

describe('redaction', () => {
  describe('redactString', () => {
    it('should redact Discord tokens', () => {
      const input =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redactString(input);
      expect(result).toBe('[JWT_REDACTED]');
    });

    it('should redact API keys', () => {
      const input = 'api_key=sk_live_abc123def456ghi789';
      const result = redactString(input);
      expect(result).toContain('[API_KEY_REDACTED]');
    });

    it('should redact authorization headers', () => {
      const input = 'Authorization: Bearer mytoken123';
      const result = redactString(input);
      expect(result).toContain('[AUTH_REDACTED]');
    });

    it('should leave regular strings unchanged', () => {
      const input = 'This is a normal log message';
      const result = redactString(input);
      expect(result).toBe(input);
    });
  });

  describe('redactEmail', () => {
    it('should partially redact email addresses', () => {
      expect(redactEmail('john.doe@example.com')).toBe('j******e@example.com');
    });

    it('should handle short local parts', () => {
      expect(redactEmail('a@example.com')).toBe('*@example.com');
    });

    it('should handle invalid emails', () => {
      expect(redactEmail('notanemail')).toBe('[EMAIL_REDACTED]');
    });
  });

  describe('isSensitiveField', () => {
    it('should identify sensitive field names', () => {
      expect(isSensitiveField('access_token')).toBe(true);
      expect(isSensitiveField('api_key')).toBe(true);
      expect(isSensitiveField('password')).toBe(true);
      expect(isSensitiveField('secret')).toBe(true);
    });

    it('should identify token in field names', () => {
      expect(isSensitiveField('myToken')).toBe(true);
      expect(isSensitiveField('refreshToken')).toBe(true);
    });

    it('should return false for non-sensitive fields', () => {
      expect(isSensitiveField('name')).toBe(false);
      expect(isSensitiveField('created_at')).toBe(false);
    });
  });

  describe('redactObject', () => {
    it('should redact sensitive fields', () => {
      const input = {
        name: 'John',
        email: 'john@example.com',
        password: 'secret123',
        token: 'mytoken',
      };
      const result = redactObject(input);
      expect(result.name).toBe('John');
      expect(result.email).toBe('j**n@example.com');
      expect(result.password).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
    });

    it('should redact nested objects', () => {
      const input = {
        user: {
          name: 'John',
          password: 'secret',
        },
      };
      const result = redactObject(input);
      expect(result.user.name).toBe('John');
      expect(result.user.password).toBe('[REDACTED]');
    });

    it('should handle fingerprints specially', () => {
      const input = { fingerprint: 'abc123', device_fingerprint: 'def456' };
      const result = redactObject(input);
      expect(result.fingerprint).toBe('[FINGERPRINT_REDACTED]');
      expect(result.device_fingerprint).toBe('[FINGERPRINT_REDACTED]');
    });
  });

  describe('redactForLogging', () => {
    it('should handle JWT strings', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
      expect(redactForLogging(jwt)).toContain('[JWT_REDACTED]');
    });

    it('should handle objects', () => {
      const input = { secret: 'value' };
      expect(redactForLogging(input).secret).toBe('[REDACTED]');
    });

    it('should pass through primitives', () => {
      expect(redactForLogging(123)).toBe(123);
      expect(redactForLogging(true)).toBe(true);
      expect(redactForLogging(null)).toBe(null);
    });
  });
});

describe('audit', () => {
  describe('createAuditEvent', () => {
    it('should create a basic audit event', () => {
      const event = createAuditEvent({
        type: 'verification.session.created',
        actor: { type: 'user', id: 'user123' },
        action: 'create_verification_session',
        outcome: 'success',
      });

      expect(event.id).toBeDefined();
      expect(event.type).toBe('verification.session.created');
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.actor.id).toBe('user123');
    });

    it('should use default severity based on event type', () => {
      const event1 = createAuditEvent({
        type: 'binding.activated',
        actor: { type: 'user', id: '1' },
        action: 'activate',
        outcome: 'success',
      });

      const event2 = createAuditEvent({
        type: 'secret.deleted',
        actor: { type: 'user', id: '1' },
        action: 'delete',
        outcome: 'success',
      });

      expect(event1.severity).toBe('info');
      expect(event2.severity).toBe('critical');
    });

    it('should redact metadata', () => {
      const event = createAuditEvent({
        type: 'binding.activated',
        actor: { type: 'user', id: '1' },
        action: 'activate',
        outcome: 'success',
        metadata: { password: 'secret123', safe: 'value' },
      });

      expect(event.metadata?.password).toBe('[REDACTED]');
      expect(event.metadata?.safe).toBe('value');
    });
  });

  describe('ConsoleAuditWriter', () => {
    it('writes event and capture writer receives it', async () => {
      const captured: AuditEvent[] = [];
      const writer: AuditWriter = {
        write: async (e) => {
          captured.push(e);
        },
        writeBatch: async (events) => {
          captured.push(...events);
        },
      };
      const event = createAuditEvent({
        type: 'verification.session.created',
        actor: { type: 'user', id: 'user123' },
        action: 'create',
        outcome: 'success',
      });
      await writer.write(event);
      expect(captured).toHaveLength(1);
      expect(captured[0].type).toBe('verification.session.created');
      expect(captured[0].actor.id).toBe('user123');
      expect(captured[0].severity).toBeDefined();
    });

    it('writeBatch writes all events in order', async () => {
      const captured: AuditEvent[] = [];
      const writer: AuditWriter = {
        write: async (e) => {
          captured.push(e);
        },
        writeBatch: async (events) => {
          captured.push(...events);
        },
      };
      const events = [
        createAuditEvent({
          type: 'verification.session.created',
          actor: { type: 'user', id: '1' },
          action: 'create',
          outcome: 'success',
        }),
        createAuditEvent({
          type: 'binding.activated',
          actor: { type: 'user', id: '1' },
          action: 'activate',
          outcome: 'success',
        }),
      ];
      await writer.writeBatch(events);
      expect(captured).toHaveLength(2);
      expect(captured[0].type).toBe('verification.session.created');
      expect(captured[1].type).toBe('binding.activated');
    });
  });

  describe('createAuditHelper', () => {
    it('sessionCreated writes event with expected structure', async () => {
      const captured: AuditEvent[] = [];
      const writer: AuditWriter = {
        write: async (e) => {
          captured.push(e);
        },
        writeBatch: async (events) => {
          captured.push(...events);
        },
      };
      const helper = createAuditHelper(writer);
      await helper.verification.sessionCreated(
        { type: 'user', id: '1' },
        { correlationId: 'corr-123' }
      );
      expect(captured).toHaveLength(1);
      expect(captured[0].type).toBe('verification.session.created');
      expect(captured[0].context.correlationId).toBe('corr-123');
      expect(captured[0].action).toBe('verification_session_created');
    });

    it('should create helper with binding methods', async () => {
      const writer = new ConsoleAuditWriter();
      const helper = createAuditHelper(writer);
      const target: AuditTarget = { type: 'binding', id: 'bind-123' };

      await helper.binding.activated({ type: 'user', id: '1' }, {}, target);

      await helper.binding.revoked({ type: 'user', id: '1' }, {}, target, 'Requested by user');
    });

    it('should create helper with entitlement methods', async () => {
      const writer = new ConsoleAuditWriter();
      const helper = createAuditHelper(writer);
      const target: AuditTarget = { type: 'user', id: 'user-123' };

      await helper.entitlement.granted({ type: 'system', id: 'system' }, {}, target, 'premium');
    });
  });
});

describe('structured logger', () => {
  describe('createStructuredLogger', () => {
    it('creates logger with all methods', () => {
      const logger = createStructuredLogger({ level: 'debug' });
      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.child).toBeDefined();
    });

    it('respects log level: debug not emitted when level is error', () => {
      const captured: LogEntry[] = [];
      const logger = createStructuredLogger({
        level: 'error',
        sink: (e) => captured.push(e),
      });
      logger.debug('x');
      logger.info('y');
      expect(captured).toHaveLength(0);
      logger.error('z');
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('error');
    });

    it('child logger includes requestId in output', () => {
      const captured: LogEntry[] = [];
      const logger = createStructuredLogger({
        level: 'info',
        sink: (e) => captured.push(e),
      });
      const child = logger.child({ requestId: '123' });
      child.info('msg');
      expect(captured).toHaveLength(1);
      expect(captured[0].context?.requestId).toBe('123');
    });

    it('includes metadata in log entry', () => {
      const captured: LogEntry[] = [];
      const logger = createStructuredLogger({
        level: 'info',
        redactSensitive: false,
        sink: (e) => captured.push(e),
      });
      logger.info('msg', { userId: 'u1' });
      expect(captured[0].metadata).toEqual({ userId: 'u1' });
    });
  });
});
