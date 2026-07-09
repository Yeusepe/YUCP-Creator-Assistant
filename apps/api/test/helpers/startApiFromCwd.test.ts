import { expect, it } from 'bun:test';
import { stopChildWithFallback } from './startApiFromCwd';

it('escalates child shutdown when the API child does not exit', async () => {
  const signals: NodeJS.Signals[] = [];
  const cancelFallback = stopChildWithFallback(
    {
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return true;
      },
    },
    'SIGTERM',
    1
  );

  try {
    expect(signals).toEqual(['SIGTERM']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  } finally {
    cancelFallback();
  }
});
