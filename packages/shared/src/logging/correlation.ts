// Correlation ID generation and propagation
// Supports both explicit passing and async context propagation

import { randomUUID } from 'crypto';

export type CorrelationId = string;

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): CorrelationId {
  return randomUUID();
}

/**
 * Create a correlation context that can be used to propagate ID
 */
export interface CorrelationContext {
  correlationId: CorrelationId;
  parentSpanId?: string;
  spanId: string;
}

/**
 * Generate a new correlation context with both correlation and span IDs
 */
export function createCorrelationContext(parentSpanId?: string): CorrelationContext {
  return {
    correlationId: generateCorrelationId(),
    parentSpanId,
    spanId: generateCorrelationId().slice(0, 8),
  };
}

// Simple AsyncLocalStorage polyfill for Node.js 16+
// Can be overridden with setCorrelationStorage if needed
let correlationStorage: CorrelationStorage | null = null;

export interface CorrelationStorage {
  getStore(): CorrelationContext | undefined;
  run<T>(context: CorrelationContext, fn: () => T): T;
}

/**
 * Set the correlation storage mechanism
 * Defaults to AsyncLocalStorage if available
 */
export function setCorrelationStorage(storage: CorrelationStorage | null): void {
  correlationStorage = storage;
}

/**
 * Get current correlation context from storage
 */
export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage?.getStore();
}

/**
 * Run a function within a correlation context
 */
export function runWithCorrelationContext<T>(context: CorrelationContext, fn: () => T): T {
  if (correlationStorage) {
    return correlationStorage.run(context, fn);
  }
  // Fallback: just run without context
  return fn();
}

/**
 * Create a child span ID from parent
 */
export function createChildSpanId(parentSpanId: string): string {
  return `${parentSpanId}-${generateCorrelationId().slice(0, 4)}`;
}
