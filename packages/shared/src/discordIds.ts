// Discord Snowflake docs:
// https://discord.com/developers/docs/reference#snowflakes
export const DISCORD_SNOWFLAKE_ID_PATTERN = /^\d{17,20}$/;

export function isDiscordSnowflakeId(value: string): boolean {
  return DISCORD_SNOWFLAKE_ID_PATTERN.test(value);
}

export function assertDiscordSnowflakeId(value: string, label = ''): asserts value is string {
  if (isDiscordSnowflakeId(value)) {
    return;
  }
  const labeledId = label ? `${label} ID` : 'ID';
  throw new Error(`Invalid Discord ${labeledId}`);
}
