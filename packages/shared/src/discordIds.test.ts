import { describe, expect, it } from 'bun:test';
import {
  assertDiscordSnowflakeId,
  DISCORD_SNOWFLAKE_ID_PATTERN,
  isDiscordSnowflakeId,
} from './discordIds';

const DUMMY_DISCORD_SNOWFLAKE_ID = '100000000000000001';
const DUMMY_DISCORD_MAX_LENGTH_SNOWFLAKE_ID = '10000000000000000001';

describe('discord ID helpers', () => {
  it('accepts Discord snowflake-shaped IDs', () => {
    expect(isDiscordSnowflakeId(DUMMY_DISCORD_SNOWFLAKE_ID)).toBe(true);
    expect(DISCORD_SNOWFLAKE_ID_PATTERN.test(DUMMY_DISCORD_MAX_LENGTH_SNOWFLAKE_ID)).toBe(true);
  });

  it('rejects malformed Discord snowflake IDs', () => {
    expect(isDiscordSnowflakeId('../member')).toBe(false);
    expect(isDiscordSnowflakeId('123')).toBe(false);
    expect(() => assertDiscordSnowflakeId('../member', 'source guild')).toThrow(
      'Invalid Discord source guild ID'
    );
  });
});
