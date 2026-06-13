import { mock } from 'bun:test';
import type { StructuredLogger } from '@yucp/shared';

export function createTestLogger(overrides: Partial<StructuredLogger> = {}): StructuredLogger {
  const logger: StructuredLogger = {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    child: mock(() => createTestLogger(overrides)),
  };

  return {
    ...logger,
    ...overrides,
    child: overrides.child ?? logger.child,
  };
}
