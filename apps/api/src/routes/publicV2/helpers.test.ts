import { describe, expect, it } from 'bun:test';
import {
  API_VERSION,
  errorResponse,
  extractListData,
  generateRequestId,
  jsonResponse,
  listResponse,
  parsePagination,
} from './helpers';

describe('generateRequestId', () => {
  it('produces a string starting with req_', () => {
    expect(generateRequestId()).toMatch(/^req_/);
  });

  it('has length 24 (req_ prefix + 20 hex chars)', () => {
    expect(generateRequestId()).toHaveLength(24);
  });

  it('produces unique ids per call', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
  });
});

describe('jsonResponse', () => {
  it('sets Content-Type to application/json', async () => {
    const res = jsonResponse({ ok: true });
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('sets default status 200', () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
  });

  it('uses the provided status code', () => {
    const res = jsonResponse({ ok: true }, 201);
    expect(res.status).toBe(201);
  });

  it('sets Yucp-Version header to current API version', () => {
    const res = jsonResponse({});
    expect(res.headers.get('Yucp-Version')).toBe(API_VERSION);
  });

  it('sets X-Request-Id from provided requestId', () => {
    const res = jsonResponse({}, 200, 'req_test12345678901234');
    expect(res.headers.get('X-Request-Id')).toBe('req_test12345678901234');
  });

  it('auto-generates X-Request-Id when not provided', () => {
    const res = jsonResponse({});
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
  });

  it('serialises body to JSON', async () => {
    const body = { foo: 'bar', num: 42 };
    const res = jsonResponse(body);
    const parsed = await res.json();
    expect(parsed).toEqual(body);
  });
});

describe('errorResponse', () => {
  it('returns the correct HTTP status code', () => {
    expect(errorResponse('not_found', 'msg', 404).status).toBe(404);
    expect(errorResponse('unauthorized', 'msg', 401).status).toBe(401);
  });

  it('body has RFC-7807-style shape: {error, message, requestId, status}', async () => {
    const res = errorResponse('bad_request', 'Something wrong', 400, 'req_fixed_id_123456789');
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('bad_request');
    expect(body.message).toBe('Something wrong');
    expect(body.status).toBe(400);
    expect(typeof body.requestId).toBe('string');
  });

  it('echoes the provided requestId in the body', async () => {
    const res = errorResponse('forbidden', 'No access', 403, 'req_echo_me_1234567890');
    const body = await res.json() as Record<string, unknown>;
    expect(body.requestId).toBe('req_echo_me_1234567890');
  });

  it('auto-generates requestId when not provided', async () => {
    const res = errorResponse('internal_error', 'Boom', 500);
    const body = await res.json() as Record<string, unknown>;
    expect((body.requestId as string)).toMatch(/^req_/);
  });

  it('sets Content-Type and Yucp-Version headers', () => {
    const res = errorResponse('bad_request', 'Bad', 400);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Yucp-Version')).toBe(API_VERSION);
  });
});

describe('parsePagination', () => {
  it('defaults to limit 50 with no params', () => {
    const { limit, cursor } = parsePagination(new URL('http://x.com/path'));
    expect(limit).toBe(50);
    expect(cursor).toBeUndefined();
  });

  it('parses explicit limit', () => {
    const { limit } = parsePagination(new URL('http://x.com/path?limit=25'));
    expect(limit).toBe(25);
  });

  it('clamps limit to minimum of 1', () => {
    expect(parsePagination(new URL('http://x.com/path?limit=0')).limit).toBe(1);
    expect(parsePagination(new URL('http://x.com/path?limit=-5')).limit).toBe(1);
  });

  it('clamps limit to maximum of 100', () => {
    expect(parsePagination(new URL('http://x.com/path?limit=200')).limit).toBe(100);
    expect(parsePagination(new URL('http://x.com/path?limit=101')).limit).toBe(100);
  });

  it('falls back to 50 for non-numeric limit', () => {
    expect(parsePagination(new URL('http://x.com/path?limit=abc')).limit).toBe(50);
  });

  it('reads cursor from starting_after param', () => {
    const { cursor } = parsePagination(new URL('http://x.com/path?starting_after=cursor_abc'));
    expect(cursor).toBe('cursor_abc');
  });

  it('returns undefined cursor when starting_after is absent', () => {
    const { cursor } = parsePagination(new URL('http://x.com/path'));
    expect(cursor).toBeUndefined();
  });
});

describe('listResponse', () => {
  it('returns shape {object:"list", data, hasMore, nextCursor}', async () => {
    const items = [{ id: 1 }, { id: 2 }];
    const res = listResponse(items, false, null);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe('list');
    expect(body.data).toEqual(items);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('propagates hasMore and nextCursor', async () => {
    const res = listResponse([1, 2, 3], true, 'next_abc');
    const body = await res.json() as Record<string, unknown>;
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('next_abc');
  });

  it('coerces undefined nextCursor to null', async () => {
    const res = listResponse([], false, undefined);
    const body = await res.json() as Record<string, unknown>;
    expect(body.nextCursor).toBeNull();
  });

  it('sets Yucp-Version and X-Request-Id headers', () => {
    const res = listResponse([], false, null, 'req_list_id_1234567890');
    expect(res.headers.get('Yucp-Version')).toBe(API_VERSION);
    expect(res.headers.get('X-Request-Id')).toBe('req_list_id_1234567890');
  });
});

describe('extractListData', () => {
  it('wraps an array: {data: result, hasMore: false, nextCursor: null}', () => {
    const items = [{ a: 1 }, { b: 2 }];
    expect(extractListData(items)).toEqual({ data: items, hasMore: false, nextCursor: null });
  });

  it('handles Convex paginated shape with page + continueCursor', () => {
    const page = [{ x: 1 }];
    const result = extractListData({ page, isDone: false, continueCursor: 'abc' });
    expect(result).toEqual({ data: page, hasMore: true, nextCursor: 'abc' });
  });

  it('interprets isDone:true as hasMore:false', () => {
    const page = [{ x: 1 }];
    const result = extractListData({ page, isDone: true, continueCursor: 'abc' });
    expect(result.hasMore).toBe(false);
  });

  it('handles shape with items + hasMore + cursor', () => {
    const items = [{ id: 'a' }];
    const result = extractListData({ items, hasMore: true, cursor: 'xyz' });
    expect(result).toEqual({ data: items, hasMore: true, nextCursor: 'xyz' });
  });

  it('handles shape with data + hasMore fields', () => {
    const data = [{ id: 'b' }];
    const result = extractListData({ data, hasMore: false });
    expect(result).toEqual({ data, hasMore: false, nextCursor: null });
  });

  it('returns empty result for null input', () => {
    expect(extractListData(null)).toEqual({ data: [], hasMore: false, nextCursor: null });
  });

  it('returns empty result for undefined input', () => {
    expect(extractListData(undefined)).toEqual({ data: [], hasMore: false, nextCursor: null });
  });

  it('returns empty result for non-object primitives', () => {
    expect(extractListData(42)).toEqual({ data: [], hasMore: false, nextCursor: null });
    expect(extractListData('string')).toEqual({ data: [], hasMore: false, nextCursor: null });
  });

  it('returns empty data array for object with no recognised list field', () => {
    const result = extractListData({ foo: 'bar' });
    expect(result.data).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});
