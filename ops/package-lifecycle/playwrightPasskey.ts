import type { Browser, BrowserContext, Page } from 'playwright';

export interface PasskeyMeasuredSession {
  context: BrowserContext;
  page: Page;
}

export type PasskeyFlowStep =
  | 'configure-virtual-authenticator'
  | 'redeem-enrollment-capability'
  | 'open-security-page'
  | 'start-passkey-enrollment'
  | 'wait-for-enrollment-confirmation'
  | 'open-account-page'
  | 'sign-out-bootstrap-session'
  | 'wait-for-sign-out'
  | 'start-measured-passkey-sign-in'
  | 'wait-for-measured-sign-in'
  | 'verify-measured-session';

export class PasskeyFlowError extends Error {
  readonly step: PasskeyFlowStep;

  constructor(step: PasskeyFlowStep, cause: unknown) {
    super('PACKAGE_LIFECYCLE_PASSKEY_STEP_FAILED', { cause });
    this.name = 'PasskeyFlowError';
    this.step = step;
  }
}

async function passkeyStep<T>(step: PasskeyFlowStep, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof PasskeyFlowError ? error : new PasskeyFlowError(step, error);
  }
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send('WebAuthn.enable');
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      automaticPresenceSimulation: true,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      protocol: 'ctap2',
      transport: 'internal',
    },
  });
}

export async function enrollAndMeasurePasskey(input: {
  browser: Browser;
  enrollmentCapability: string;
  webUrl: string;
}): Promise<PasskeyMeasuredSession> {
  const context = await input.browser.newContext();
  const page = await context.newPage();
  try {
    await passkeyStep('configure-virtual-authenticator', () =>
      addVirtualAuthenticator(context, page)
    );
    await passkeyStep('redeem-enrollment-capability', async () => {
      await page.goto(`${input.webUrl}/sign-in`, {
        waitUntil: 'domcontentloaded',
      });
      const redeemed = await page.evaluate(async (token) => {
        const response = await fetch('/api/auth/one-time-token/verify', {
          body: JSON.stringify({ token }),
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
        return response.ok;
      }, input.enrollmentCapability);
      if (!redeemed) {
        throw new Error('Enrollment capability redemption failed');
      }
    });

    await passkeyStep('open-security-page', () =>
      page.goto(`${input.webUrl}/account/security`, {
        waitUntil: 'domcontentloaded',
      })
    );
    await passkeyStep('start-passkey-enrollment', () =>
      page.getByRole('button', { name: 'Add passkey' }).click()
    );
    await passkeyStep('wait-for-enrollment-confirmation', () =>
      page.getByText('Passkey added', { exact: true }).waitFor()
    );

    await passkeyStep('open-account-page', () =>
      page.goto(`${input.webUrl}/account`, {
        waitUntil: 'domcontentloaded',
      })
    );
    await passkeyStep('sign-out-bootstrap-session', () =>
      page.getByRole('button', { name: 'Sign out', exact: true }).click()
    );
    await passkeyStep('wait-for-sign-out', () =>
      page.waitForURL((url) => url.pathname === '/sign-in')
    );

    await passkeyStep('start-measured-passkey-sign-in', () =>
      page.getByRole('button', { name: 'Sign in with passkey' }).click()
    );
    await passkeyStep('wait-for-measured-sign-in', () =>
      page.waitForURL((url) => url.pathname !== '/sign-in')
    );
    const cookies = await passkeyStep('verify-measured-session', () =>
      context.cookies(input.webUrl)
    );
    if (!cookies.some((cookie) => cookie.name === 'yucp.session_token')) {
      throw new PasskeyFlowError('verify-measured-session', new Error('Session cookie missing'));
    }
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}
