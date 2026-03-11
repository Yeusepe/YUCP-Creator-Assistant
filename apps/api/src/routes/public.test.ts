import { describe, expect, it } from 'bun:test';
import { parseSubjectSelector } from './public';

describe('parseSubjectSelector', () => {
  it('accepts subjectId selectors', () => {
    expect(parseSubjectSelector({ subjectId: 'subject_123' })).toEqual({
      subjectId: 'subject_123',
    });
  });

  it('accepts external account selectors', () => {
    expect(
      parseSubjectSelector({
        externalAccount: { provider: 'gumroad', providerUserId: 'buyer_123' },
      })
    ).toEqual({
      externalAccount: { provider: 'gumroad', providerUserId: 'buyer_123' },
    });
  });

  it('rejects ambiguous selectors', () => {
    expect(parseSubjectSelector({ subjectId: 'a', authUserId: 'b' })).toBeNull();
  });

  it('rejects invalid selector payloads', () => {
    expect(parseSubjectSelector({})).toBeNull();
    expect(parseSubjectSelector(null)).toBeNull();
  });
});
