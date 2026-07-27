const TRACEPARENT_V00_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/;

export type ParsedTraceparent = {
  flags: '00' | '01';
  parentId: string;
  traceId: string;
  version: '00';
};

export function parseTraceparent(value: string): ParsedTraceparent | null {
  const match = TRACEPARENT_V00_PATTERN.exec(value);
  if (
    !match ||
    match[1] === '00000000000000000000000000000000' ||
    match[2] === '0000000000000000'
  ) {
    return null;
  }
  return {
    flags: match[3] as '00' | '01',
    parentId: match[2],
    traceId: match[1],
    version: '00',
  };
}
