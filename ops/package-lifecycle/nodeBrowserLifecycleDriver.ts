import { createInterface } from 'node:readline';
import { type Browser, chromium } from 'playwright';
import {
  BrowserDriverProtocolError,
  type BrowserDriverRequest,
  MAX_BROWSER_DRIVER_MESSAGE_BYTES,
  parseBrowserDriverRequest,
} from './nodeBrowserLifecycleProtocol';
import {
  enrollAndMeasurePasskey,
  PasskeyFlowError,
  type PasskeyMeasuredSession,
} from './playwrightPasskey';

type DriverResponse = {
  error?: {
    code: string;
    step?: string;
  };
  ok: boolean;
  runId: string;
  sequence: number;
  result?: unknown;
};

let browser: Browser | undefined;
let creator: PasskeyMeasuredSession | undefined;
let buyer: PasskeyMeasuredSession | undefined;

async function getBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: true });
  return browser;
}

async function closeDriver(): Promise<void> {
  await Promise.all([
    creator?.context.close().catch(() => undefined),
    buyer?.context.close().catch(() => undefined),
  ]);
  creator = undefined;
  buyer = undefined;
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

async function execute(request: BrowserDriverRequest): Promise<unknown> {
  if (request.method === 'smoke') {
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto('data:text/html,<title>Node bridge</title>');
      return { title: await page.title() };
    } finally {
      await page.close();
    }
  }
  if (request.method === 'enrollPasskeys') {
    const activeBrowser = await getBrowser();
    creator = await enrollAndMeasurePasskey({
      browser: activeBrowser,
      enrollmentCapability: request.params.creatorEnrollmentCapability,
      webUrl: request.params.webUrl,
    });
    buyer = await enrollAndMeasurePasskey({
      browser: activeBrowser,
      enrollmentCapability: request.params.buyerEnrollmentCapability,
      webUrl: request.params.webUrl,
    });
    return { buyer: 'measured', creator: 'measured' };
  }
  if (request.method === 'creatorUpload') {
    if (!creator) {
      throw new Error('Creator session is unavailable');
    }
    const page = creator.page;
    const { packageId, packagePath, productName, version, webUrl } = request.params;
    await page.goto(`${webUrl}/dashboard/packages`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Upload a package' }).click();
    await page.getByPlaceholder('Choose a product').click();
    await page.getByRole('option', { name: productName }).click();
    await page.getByLabel('Install ID').fill(packageId);
    await page.getByLabel('Version').fill(version);
    await page.getByLabel('Choose package file').setInputFiles(packagePath);
    await page.getByRole('button', { name: 'Upload package' }).click();
    await page.getByText('Upload complete', { exact: true }).waitFor({ timeout: 180_000 });
    return { status: 'complete' };
  }
  if (request.method === 'creatorEnsureVccLink') {
    if (!creator) {
      throw new Error('Creator session is unavailable');
    }
    const { catalogProductId, webUrl } = request.params;
    await creator.page.goto(`${webUrl}/dashboard/packages`, {
      waitUntil: 'domcontentloaded',
    });
    const result = await creator.page.evaluate(
      async (input) => {
        const response = await fetch(
          `/api/creator/packages/${encodeURIComponent(input.catalogProductId)}/vcc-link`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: '{}',
          }
        );
        const body = (await response.json()) as {
          addRepoUrl?: unknown;
          indexUrl?: unknown;
        };
        if (
          !response.ok ||
          typeof body.addRepoUrl !== 'string' ||
          typeof body.indexUrl !== 'string'
        ) {
          throw new Error('Creator VCC link creation failed');
        }
        return {
          addRepoUrl: body.addRepoUrl,
          indexUrl: body.indexUrl,
        };
      },
      { catalogProductId }
    );
    return result;
  }
  if (request.method === 'buyerVerify') {
    if (!buyer) {
      throw new Error('Buyer session is unavailable');
    }
    const page = buyer.page;
    const { catalogProductId, licenseKey, webUrl } = request.params;
    await page.goto(`${webUrl}/access/${catalogProductId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByLabel('License key').fill(licenseKey);
    await page.getByRole('button', { name: 'Verify purchase' }).click();
    await page
      .getByText(/verified|access confirmed/i)
      .first()
      .waitFor({ timeout: 60_000 });
    return { status: 'verified' };
  }
  if (request.method === 'buyerAuthorizeUnity') {
    if (!buyer) {
      throw new Error('Buyer session is unavailable');
    }
    const page = buyer.page;
    await page.goto(request.params.authorizationUrl, {
      waitUntil: 'domcontentloaded',
    });
    const allow = page.getByRole('button', { name: 'Allow access', exact: true });
    if (await allow.isVisible().catch(() => false)) {
      await allow.click();
    }
    await page.waitForURL(
      (url) =>
        url.hostname === '127.0.0.1' && (url.pathname === '/callback' || url.pathname === '/'),
      { timeout: 60_000 }
    );
    return { status: 'authorized' };
  }
  if (request.method === 'buyerNavigate') {
    if (!buyer) {
      throw new Error('Buyer session is unavailable');
    }
    await buyer.page.goto(request.params.url, { waitUntil: 'domcontentloaded' });
    return { status: 'navigated' };
  }
  if (request.method === 'stop') {
    await closeDriver();
    return { status: 'stopped' };
  }
  throw new Error('Unknown driver method');
}

function writeResponse(response: DriverResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin });
  let activeRunId: string | undefined;
  let expectedSequence = 1;
  for await (const line of input) {
    let request: BrowserDriverRequest | undefined;
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_BROWSER_DRIVER_MESSAGE_BYTES) {
        throw new BrowserDriverProtocolError();
      }
      request = parseBrowserDriverRequest(JSON.parse(line) as unknown);
      if (
        request.sequence !== expectedSequence ||
        (activeRunId !== undefined && request.runId !== activeRunId)
      ) {
        throw new BrowserDriverProtocolError();
      }
      activeRunId ??= request.runId;
      expectedSequence += 1;
    } catch {
      writeResponse({
        error: { code: 'PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID' },
        ok: false,
        runId: request?.runId ?? 'invalid',
        sequence: request?.sequence ?? 0,
      });
      break;
    }

    try {
      const result = await execute(request);
      writeResponse({
        ok: true,
        result,
        runId: request.runId,
        sequence: request.sequence,
      });
      if (request.method === 'stop') {
        break;
      }
    } catch (error) {
      writeResponse({
        error:
          error instanceof PasskeyFlowError
            ? {
                code: 'PACKAGE_LIFECYCLE_PASSKEY_STEP_FAILED',
                step: error.step,
              }
            : { code: 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_FAILED' },
        ok: false,
        runId: request.runId,
        sequence: request.sequence,
      });
    }
  }
  await closeDriver();
}

void main().catch(async () => {
  await closeDriver();
  process.exitCode = 1;
});
