import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { BetterAuthEndpointError } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';

interface AccountSecurityRoutesConfig {
  convexUrl: string;
  convexApiSecret: string;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

class ClientSafeError extends Error {
  override readonly name = 'ClientSafeError';
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function getSafeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ClientSafeError && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function getErrorLogDetails(error: unknown) {
  if (error instanceof BetterAuthEndpointError) {
    const betterAuthBodyKeys =
      error.body && typeof error.body === 'object'
        ? Object.keys(error.body as Record<string, unknown>)
        : [];

    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      betterAuthPath: error.path,
      betterAuthStatus: error.status,
      betterAuthBodyRedacted: error.body !== null || error.bodyText.trim().length > 0,
      betterAuthBodyKeys,
    };
  }
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  return {
    errorValue: String(error),
  };
}

export function createAccountSecurityRoutes(auth: Auth, config: AccountSecurityRoutesConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

  async function startRecovery(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const body = await readJsonBody<{ email?: string }>(request);
    const email = body?.email?.trim();
    if (!email) {
      return jsonResponse({ error: 'Email is required' }, 400);
    }

    try {
      const resolution = await convex.query(api.accountSecurity.resolveRecoveryLookupForApi, {
        apiSecret: config.convexApiSecret,
        email,
      });

      if (resolution?.authUserId && resolution.emailDeliveryMethod && resolution.targetEmail) {
        await convex.mutation(api.accountSecurity.beginEmailRecoveryForApi, {
          apiSecret: config.convexApiSecret,
          authUserId: resolution.authUserId,
          lookupEmail: email,
          deliveryMethod: resolution.emailDeliveryMethod,
          targetEmail: resolution.targetEmail,
        });
        await auth.sendEmailOtp({
          email: resolution.targetEmail,
          type: 'forget-password',
        });
      }
    } catch (error) {
      logger.warn('Account recovery start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return jsonResponse({
      success: true,
      message:
        'If that account can recover by email, a recovery code has been sent. Backup codes and support recovery remain available.',
    });
  }

  async function verifyRecoveryEmail(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const body = await readJsonBody<{ email?: string; otp?: string }>(request);
    const email = body?.email?.trim();
    const otp = body?.otp?.trim();
    if (!email || !otp) {
      return jsonResponse({ error: 'Email and code are required' }, 400);
    }

    try {
      const pending = await convex.query(api.accountSecurity.getPendingEmailRecoveryForApi, {
        apiSecret: config.convexApiSecret,
        email,
      });

      if (!pending?.targetEmail) {
        return jsonResponse({ error: 'Invalid or expired recovery code' }, 400);
      }

      await auth.checkEmailOtp({
        email: pending.targetEmail,
        type: 'forget-password',
        otp,
      });

      const completed = await convex.mutation(api.accountSecurity.consumeEmailRecoveryForApi, {
        apiSecret: config.convexApiSecret,
        email,
        sessionId: pending.sessionId,
      });

      if (!completed) {
        return jsonResponse({ error: 'Invalid or expired recovery code' }, 400);
      }

      return jsonResponse({
        success: true,
        recoveryPasskeyContext: completed.recoveryPasskeyContext,
        expiresAt: completed.expiresAt,
      });
    } catch (error) {
      logger.warn('Account recovery email verification failed', getErrorLogDetails(error));
      return jsonResponse(
        {
          error: getSafeErrorMessage(error, 'Invalid or expired recovery code'),
        },
        400
      );
    }
  }

  async function verifyRecoveryBackupCode(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const body = await readJsonBody<{ email?: string; backupCode?: string }>(request);
    const email = body?.email?.trim();
    const backupCode = body?.backupCode?.trim();
    if (!email || !backupCode) {
      return jsonResponse({ error: 'Email and backup code are required' }, 400);
    }

    try {
      const completed = await convex.mutation(api.accountSecurity.consumeBackupCodeRecoveryForApi, {
        apiSecret: config.convexApiSecret,
        email,
        backupCode,
      });

      if (!completed) {
        return jsonResponse({ error: 'Invalid backup code' }, 400);
      }

      return jsonResponse({
        success: true,
        recoveryPasskeyContext: completed.recoveryPasskeyContext,
        expiresAt: completed.expiresAt,
      });
    } catch (error) {
      logger.warn('Account recovery backup code verification failed', getErrorLogDetails(error));
      return jsonResponse(
        {
          error: getSafeErrorMessage(error, 'Invalid backup code'),
        },
        400
      );
    }
  }

  async function verifyRecoveryContactEnrollment(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const session = await auth.getSession(request);
    if (!session?.user?.id) {
      return jsonResponse({ error: 'Authentication required' }, 401);
    }

    const body = await readJsonBody<{ email?: string; otp?: string }>(request);
    const email = body?.email?.trim();
    const otp = body?.otp?.trim();
    if (!email || !otp) {
      return jsonResponse({ error: 'Email and code are required' }, 400);
    }

    try {
      await auth.checkEmailOtp({
        email,
        type: 'email-verification',
        otp,
      });

      await convex.mutation(api.accountSecurity.verifyRecoveryContactEnrollmentForApi, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        email,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      logger.warn('Recovery email enrollment verification failed', getErrorLogDetails(error));
      return jsonResponse(
        {
          error: getSafeErrorMessage(error, 'Invalid verification code'),
        },
        400
      );
    }
  }

  return {
    startRecovery,
    verifyRecoveryEmail,
    verifyRecoveryBackupCode,
    verifyRecoveryContactEnrollment,
  };
}
