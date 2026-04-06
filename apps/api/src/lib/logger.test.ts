import { describe, expect, it } from 'bun:test';
import { createStructuredLogger } from '@yucp/shared';
import { logger } from './logger';

describe('logger (API singleton)', () => {
  it('exposes the full StructuredLogger interface', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('child() returns a distinct logger with the same interface', () => {
    const child = logger.child({ requestId: 'req-test-123' });
    expect(child).not.toBe(logger);
    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
  });

  it('child() logger includes bound context in log entries', () => {
    const captured: import('@yucp/shared').LogEntry[] = [];
    const base = createStructuredLogger({ level: 'debug', sink: (e) => captured.push(e) });
    const child = base.child({ requestId: 'req-abc' });
    child.info('test message');

    expect(captured).toHaveLength(1);
    expect(captured[0].context?.requestId).toBe('req-abc');
    expect(captured[0].message).toBe('test message');
  });

  it('respects log level: lower-priority entries are suppressed', () => {
    const captured: import('@yucp/shared').LogEntry[] = [];
    const restricted = createStructuredLogger({ level: 'error', sink: (e) => captured.push(e) });
    restricted.info('should not appear');
    restricted.warn('also suppressed');
    expect(captured).toHaveLength(0);
    restricted.error('should appear');
    expect(captured).toHaveLength(1);
  });
});
