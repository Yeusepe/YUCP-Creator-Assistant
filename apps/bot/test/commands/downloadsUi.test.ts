import { describe, expect, it } from 'bun:test';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  buildAccessComponents,
  buildBackfillAutofixConfirmComponents,
  buildManageComponents,
  buildManageMessageModal,
  buildMessageCustomizeModal,
  buildSourceArchiveComponents,
} from '../../src/commands/downloadsUi';

type JsonComponent = {
  custom_id?: string;
  label?: string;
  options?: Array<{ value?: string; default?: boolean }>;
  value?: string;
  placeholder?: string;
};

type JsonRow = {
  components?: JsonComponent[];
};

type JsonModal = {
  custom_id?: string;
  components?: JsonRow[];
};

function getJsonRow(row: { toJSON: () => unknown }): JsonRow {
  return row.toJSON() as JsonRow;
}

function getComponentCustomIds(rows: Array<{ toJSON: () => unknown }>): string[] {
  return rows.flatMap((row) =>
    (getJsonRow(row).components ?? [])
      .map((component) => component.custom_id)
      .filter((customId): customId is string => typeof customId === 'string')
  );
}

describe('downloads UI builders', () => {
  it('preserves exact custom ids for source/archive setup and access controls', () => {
    const sourceArchiveRows = buildSourceArchiveComponents('user_dl_ui', 'auth_dl_ui', {
      sourceChannelId: 'source_channel',
      archiveChannelId: 'archive_channel',
    });
    const accessRows = buildAccessComponents('user_dl_ui', 'auth_dl_ui', {
      requiredRoleIds: ['role_one', 'role_two'],
      roleLogic: 'any',
      allowedExtensions: ['SBSAR', 'blend', 'fbx', 'sbscfg', 'spp'],
    });

    expect(getComponentCustomIds(sourceArchiveRows)).toEqual([
      'creator_downloads:source_select:user_dl_ui:auth_dl_ui',
      'creator_downloads:archive_select:user_dl_ui:auth_dl_ui',
      'creator_downloads:to_access:user_dl_ui:auth_dl_ui',
      'creator_downloads:cancel_add:user_dl_ui:auth_dl_ui',
    ]);
    expect(getComponentCustomIds(accessRows)).toEqual([
      'creator_downloads:roles_select:user_dl_ui:auth_dl_ui',
      'creator_downloads:logic_select:user_dl_ui:auth_dl_ui',
      'creator_downloads:ext_select:user_dl_ui:auth_dl_ui',
      'creator_downloads:back_to_channels:user_dl_ui:auth_dl_ui',
      'creator_downloads:to_confirm:user_dl_ui:auth_dl_ui',
      'creator_downloads:cancel_add:user_dl_ui:auth_dl_ui',
    ]);

    const extensionOptions = getJsonRow(accessRows[2]).components?.[0]?.options;
    expect(extensionOptions?.find((option) => option.value === 'source_assets')?.default).toBe(
      true
    );
  });

  it('preserves exact backfill autofix ids, including cancel token format', () => {
    const rows = buildBackfillAutofixConfirmComponents(
      'user_dl_ui',
      'auth_dl_ui',
      'route_dl_ui' as Id<'download_routes'>
    );

    expect(getComponentCustomIds(rows)).toEqual([
      'creator_downloads:autofix_run:user_dl_ui:auth_dl_ui:route_dl_ui',
      'creator_downloads:autofix_cancel:user_dl_ui:route_dl_ui',
    ]);
  });

  it('builds manage controls and message modals with the existing ids and seeded values', () => {
    const manageRows = buildManageComponents(
      'panel_dl_ui',
      [
        {
          _id: 'route_dl_one' as Id<'download_routes'>,
          authUserId: 'auth_dl_ui',
          guildId: 'guild_dl_ui',
          sourceChannelId: 'source_one',
          archiveChannelId: 'archive_one',
          messageTitle: 'Ready to Download',
          messageBody: 'Open Download to check access.',
          requiredRoleIds: ['role_one'],
          roleLogic: 'all',
          allowedExtensions: ['fbx'],
          enabled: false,
          sourceName: 'Uploads',
          archiveName: 'Archive',
        },
      ],
      'route_dl_one' as Id<'download_routes'>
    );
    const customizeModal = buildMessageCustomizeModal('user_dl_ui', 'auth_dl_ui', {
      messageTitle: 'Custom Title',
      messageBody: 'Custom Body',
    });
    const manageModal = buildManageMessageModal('panel_dl_ui', {
      messageTitle: 'Route Title',
      messageBody: 'Route Body',
    });

    expect(getComponentCustomIds(manageRows)).toEqual([
      'creator_downloads:manage_select:panel_dl_ui',
      'creator_downloads:manage_toggle:panel_dl_ui',
      'creator_downloads:manage_edit_message:panel_dl_ui',
      'creator_downloads:manage_remove_prompt:panel_dl_ui',
    ]);
    expect(getJsonRow(manageRows[1]).components?.[0]?.label).toBe('Turn On');

    const customizeJson = customizeModal.toJSON() as JsonModal;
    expect(customizeJson.custom_id).toBe('creator_downloads:message_modal:user_dl_ui:auth_dl_ui');
    expect(customizeJson.components?.[0]?.components?.[0]?.value).toBe('Custom Title');
    expect(customizeJson.components?.[1]?.components?.[0]?.value).toBe('Custom Body');

    const manageJson = manageModal.toJSON() as JsonModal;
    expect(manageJson.custom_id).toBe('creator_downloads:manage_message_modal:panel_dl_ui');
    expect(manageJson.components?.[0]?.components?.[0]?.value).toBe('Route Title');
    expect(manageJson.components?.[1]?.components?.[0]?.value).toBe('Route Body');
  });

  it('does not crash when manage routes are empty', () => {
    const manageRows = buildManageComponents(
      'panel_dl_ui',
      [],
      'route_missing' as Id<'download_routes'>
    );

    expect(getComponentCustomIds(manageRows)).toEqual([
      'creator_downloads:manage_select:panel_dl_ui',
      'creator_downloads:manage_toggle:panel_dl_ui',
      'creator_downloads:manage_edit_message:panel_dl_ui',
      'creator_downloads:manage_remove_prompt:panel_dl_ui',
    ]);
    expect(getJsonRow(manageRows[1]).components?.[0]?.label).toBe('Turn On');
  });
});
