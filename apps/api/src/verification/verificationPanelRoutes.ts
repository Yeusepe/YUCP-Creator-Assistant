import type { StructuredLogger } from '@yucp/shared';
import { decrypt, encrypt } from '../lib/encrypt';
import { getStateStore } from '../lib/stateStore';
import { createApiVerificationSupportError } from '../lib/verificationSupport';
import type { VerificationConfig } from './verificationConfig';
import {
  buildVerifyPanelRefreshReply,
  INTERACTION_TOKEN_PURPOSE,
  isAllowedVerifyPanelOrigin,
  jsonNoStore,
  type StoredVerifyPanel,
  VERIFY_PANEL_PREFIX,
  VERIFY_PANEL_TTL_MS,
} from './verificationRouteSupport';

interface CreateVerificationPanelRouteHandlersOptions {
  config: VerificationConfig;
  hasValidApiSecret(value: string | undefined): boolean;
  logger: StructuredLogger;
}

export function createVerificationPanelRouteHandlers({
  config,
  hasValidApiSecret,
  logger,
}: CreateVerificationPanelRouteHandlersOptions) {
  async function bindVerifyPanel(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ success: false, error: 'Method not allowed' }, { status: 405 });
    }

    let body: {
      apiSecret?: string;
      applicationId?: string;
      discordUserId?: string;
      guildId?: string;
      interactionToken?: string;
      messageId?: string;
      panelToken?: string;
      authUserId?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        error: err,
        stage: 'bind_verify_panel_parse',
      });
      return jsonNoStore(
        { success: false, error: 'Invalid JSON', supportCode: support.supportCode },
        { status: 400 }
      );
    }

    if (!hasValidApiSecret(body.apiSecret)) {
      return jsonNoStore({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    if (
      !body.applicationId ||
      !body.discordUserId ||
      !body.guildId ||
      !body.interactionToken ||
      !body.messageId ||
      !body.panelToken ||
      !body.authUserId
    ) {
      return jsonNoStore({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    try {
      const store = getStateStore();
      const encryptionSecret = config.encryptionSecret ?? '';
      const encryptedInteractionToken = encryptionSecret
        ? await encrypt(body.interactionToken, encryptionSecret, INTERACTION_TOKEN_PURPOSE)
        : body.interactionToken;
      await store.set(
        `${VERIFY_PANEL_PREFIX}${body.panelToken}`,
        JSON.stringify({
          applicationId: body.applicationId,
          discordUserId: body.discordUserId,
          guildId: body.guildId,
          encryptedInteractionToken,
          messageId: body.messageId,
          authUserId: body.authUserId,
        } satisfies StoredVerifyPanel),
        VERIFY_PANEL_TTL_MS
      );
      return jsonNoStore({ success: true }, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: body.discordUserId,
        error: err,
        guildId: body.guildId,
        stage: 'bind_verify_panel_store',
        authUserId: body.authUserId,
      });
      return jsonNoStore(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  async function refreshVerifyPanel(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ success: false, error: 'Method not allowed' }, { status: 405 });
    }

    if (!isAllowedVerifyPanelOrigin(request, config)) {
      return jsonNoStore({ success: false, error: 'Invalid request origin.' }, { status: 403 });
    }

    let body: { panelToken?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonNoStore({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const panelToken = body.panelToken?.trim();
    if (!panelToken) {
      return jsonNoStore({ success: false, error: 'Missing panel token' }, { status: 400 });
    }

    const store = getStateStore();
    const raw = await store.get(`${VERIFY_PANEL_PREFIX}${panelToken}`);
    if (!raw) {
      return jsonNoStore({ success: false, error: 'Panel token expired' }, { status: 404 });
    }

    let panel: StoredVerifyPanel;
    try {
      panel = JSON.parse(raw) as StoredVerifyPanel;
    } catch {
      await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
      return jsonNoStore({ success: false, error: 'Invalid panel token' }, { status: 400 });
    }

    const encryptionSecret = config.encryptionSecret ?? '';
    let interactionToken: string;
    try {
      interactionToken =
        encryptionSecret && panel.encryptedInteractionToken
          ? await decrypt(
              panel.encryptedInteractionToken,
              encryptionSecret,
              INTERACTION_TOKEN_PURPOSE
            )
          : panel.encryptedInteractionToken;
    } catch {
      await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
      return jsonNoStore({ success: false, error: 'Invalid panel token' }, { status: 400 });
    }

    let discordResponse: Response;
    try {
      discordResponse = await fetch(
        `https://discord.com/api/v10/webhooks/${panel.applicationId}/${interactionToken}/messages/${panel.messageId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildVerifyPanelRefreshReply()),
          signal: AbortSignal.timeout(10_000),
        }
      );
    } catch (error) {
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: panel.discordUserId,
        error: error instanceof Error ? error : new Error(String(error)),
        guildId: panel.guildId,
        stage: 'refresh_verify_panel_discord',
        authUserId: panel.authUserId,
      });
      logger.warn('Failed to refresh verify panel from success page', {
        guildId: panel.guildId,
        supportCode: support.supportCode,
        supportCodeMode: support.supportCodeMode,
        userId: panel.discordUserId,
      });
      return jsonNoStore(
        {
          success: false,
          error: 'Failed to update Discord panel',
          supportCode: support.supportCode,
        },
        { status: 502 }
      );
    }

    if (!discordResponse.ok) {
      const errorBody = await discordResponse.text().catch(() => '');
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: panel.discordUserId,
        error: new Error(`Discord refresh failed with status ${discordResponse.status}`),
        guildId: panel.guildId,
        stage: 'refresh_verify_panel_discord',
        authUserId: panel.authUserId,
      });
      logger.warn('Failed to refresh verify panel from success page', {
        bodyPreview: errorBody.slice(0, 300),
        discordStatus: discordResponse.status,
        guildId: panel.guildId,
        supportCode: support.supportCode,
        supportCodeMode: support.supportCodeMode,
        userId: panel.discordUserId,
      });
      return jsonNoStore(
        {
          success: false,
          error: 'Failed to update Discord panel',
          supportCode: support.supportCode,
        },
        { status: 502 }
      );
    }

    await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
    return jsonNoStore({ success: true }, { status: 200 });
  }

  return {
    bindVerifyPanel,
    refreshVerifyPanel,
  };
}
