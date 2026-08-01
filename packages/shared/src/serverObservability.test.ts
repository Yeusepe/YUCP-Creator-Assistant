import { describe, expect, test } from 'bun:test';
import { consoleLogRecord } from './serverObservability';

describe('console log record', () => {
  test('lifts a structured event into filterable attributes', () => {
    const record = consoleLogRecord(
      'info',
      [JSON.stringify({ event: 'ingest_tus.listening', port: 3002, ready: true })],
      'yucp-ingest-tus'
    );

    expect(record.severityText).toBe('INFO');
    expect(record.body).toBe('ingest_tus.listening');
    expect(record.attributes).toEqual({
      'service.name': 'yucp-ingest-tus',
      'log.source': 'console',
      event: 'ingest_tus.listening',
      port: 3002,
      ready: true,
    });
  });

  test('redacts secrets that a structured event carries', () => {
    const record = consoleLogRecord(
      'error',
      [
        JSON.stringify({
          event: 'ingest_tus.start_failed',
          reason: 'connect failed for postgres://catalog:hunter2@db.internal:5432/catalog',
        }),
      ],
      'yucp-ingest-tus'
    );

    expect(record.severityText).toBe('ERROR');
    expect(String(record.attributes.reason)).not.toContain('hunter2');
  });

  test('keeps unstructured output as a plain body', () => {
    const record = consoleLogRecord('warn', ['reconciler backlog', 12], 'yucp-ingest-scheduler');

    expect(record.severityText).toBe('WARN');
    expect(record.body).toBe('reconciler backlog 12');
    expect(record.attributes).toEqual({
      'service.name': 'yucp-ingest-scheduler',
      'log.source': 'console',
    });
  });

  test('does not treat a JSON array as an event', () => {
    const record = consoleLogRecord('info', [JSON.stringify([1, 2, 3])], 'yucp-storage-gc');

    expect(record.body).toBe('[1,2,3]');
    expect(record.attributes).toEqual({
      'service.name': 'yucp-storage-gc',
      'log.source': 'console',
    });
  });
});
