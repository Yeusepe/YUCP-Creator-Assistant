import { describe, expect, test } from 'bun:test';
import { PasskeyFlowError } from './playwrightPasskey';

describe('Playwright passkey flow diagnostics', () => {
  test('reports a stable step without exposing the browser error', () => {
    const error = new PasskeyFlowError(
      'wait-for-enrollment-confirmation',
      new Error('credential-value-must-not-escape')
    );

    expect(error.step).toBe('wait-for-enrollment-confirmation');
    expect(error.message).toBe('PACKAGE_LIFECYCLE_PASSKEY_STEP_FAILED');
    expect(error.message).not.toContain('credential-value-must-not-escape');
    expect(error.cause).toBeInstanceOf(Error);
  });
});
