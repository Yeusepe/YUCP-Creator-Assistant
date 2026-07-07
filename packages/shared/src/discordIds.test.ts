import { describe, expect, it } from 'bun:test';
import {
  assertDiscordSnowflakeId,
  DISCORD_SNOWFLAKE_ID_PATTERN,
  isDiscordSnowflakeId,
} from './discordIds';

describe('discord ID helpers', () => {
  it('accepts Discord snowflake-shaped IDs', () => {
    expect(isDiscordSnowflakeId('123456789012345678')).toBe(true);
    expect(DISCORD_SNOWFLAKE_ID_PATTERN.test('12345678901234567890')).toBe(true);
  });

  it('rejects malformed Discord snowflake IDs', () => {
    expect(isDiscordSnowflakeId('../member')).toBe(false);
    expect(isDiscordSnowflakeId('123')).toBe(false);
    expect(() => assertDiscordSnowflakeId('../member', 'source guild')).toThrow(
      'Invalid Discord source guild ID'
    );
  });
});
