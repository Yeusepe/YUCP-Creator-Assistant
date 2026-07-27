import { describe, expect, test } from 'bun:test';
import { parseTraceparent } from './traceparent';

describe('parseTraceparent', () => {
  test('accepts supported W3C version 00 contexts', () => {
    expect(parseTraceparent('00-11111111111111111111111111111111-2222222222222222-01')).toEqual({
      flags: '01',
      parentId: '2222222222222222',
      traceId: '11111111111111111111111111111111',
      version: '00',
    });
  });

  test.each([
    '00-00000000000000000000000000000000-2222222222222222-01',
    '00-11111111111111111111111111111111-0000000000000000-01',
    '00-11111111111111111111111111111111-2222222222222222-02',
    '01-11111111111111111111111111111111-2222222222222222-01',
    '00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-2222222222222222-01',
  ])('rejects unsupported or invalid context %s', (value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});
