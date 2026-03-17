/**
 * Mock Discord.js interaction factories for unit testing bot handlers.
 *
 * Discord.js ChatInputCommandInteraction cannot be constructed without a live
 * gateway connection. These factories produce plain objects with the exact
 * properties that bot handlers access, using Bun's mock() for all response
 * methods so tests can inspect calls via `.mock.calls`.
 */
import { mock } from 'bun:test';

// ─── Permission bit constants (Discord API) ───────────────────────────────────

/** Discord MANAGE_GUILD permission bit */
export const MANAGE_GUILD_BIT = 0x20n;
/** Discord ADMINISTRATOR permission bit */
export const ADMINISTRATOR_BIT = 0x8n;

// ─── MockFn type ──────────────────────────────────────────────────────────────

/**
 * Structural type that is satisfied by any Bun `mock()` return value.
 * Only `calls` is required; it's the only field used by assertion helpers.
 */
export interface MockFn {
  // biome-ignore lint/suspicious/noExplicitAny: intentionally broad for mock recording
  (...args: any[]): any;
  mock: {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broad for mock recording
    calls: any[][];
  };
}

// ─── MockInteraction interface ────────────────────────────────────────────────

/**
 * Plain-object shape covering every property that bot interaction handlers
 * actually read from a Discord.js interaction.
 */
export interface MockInteraction {
  // ── User identity ──────────────────────────────────────────────────────────
  user: {
    id: string;
    username: string;
    displayName: string;
    displayAvatarURL: (opts?: Record<string, unknown>) => string;
  };
  /** Used by bindVerifyPanelToken */
  applicationId: string;
  /** Used by bindVerifyPanelToken */
  token: string;

  // ── Guild / server context ─────────────────────────────────────────────────
  guildId: string | null;
  guild: { roles: { fetch: (id: string) => Promise<{ name: string } | null> } } | null;
  channel: { send: MockFn } | null;
  /** Either an object (GuildMember) or a string (API member) – handlers guard with typeof check */
  member: { permissions: { has: (bit: bigint) => boolean } } | string | null;

  // ── Command routing ────────────────────────────────────────────────────────
  commandName: string;
  /** For button / modal / select interactions */
  customId: string;
  /** StringSelectMenu values array */
  values: string[];

  // ── Slash command options ──────────────────────────────────────────────────
  options: {
    getSubcommand(required?: boolean): string | null;
    getSubcommandGroup(required?: boolean): string | null;
    getString(name: string, required?: boolean): string | null;
    getUser(
      name: string,
      required?: boolean
    ): { id: string; username: string; displayName?: string } | null;
    getMentionable(name: string, required?: boolean): unknown;
    getBoolean(name: string, required?: boolean): boolean | null;
    /** getFocused(true) returns the full option object; getFocused() returns the raw value string */
    getFocused(full?: boolean): { name: string; value: string } | string;
  };

  // ── Modal text input fields ────────────────────────────────────────────────
  fields: {
    getTextInputValue: (customId: string) => string;
  };

  // ── Async response methods (all Bun mocks) ─────────────────────────────────
  reply: MockFn;
  deferReply: MockFn;
  deferUpdate: MockFn;
  editReply: MockFn;
  update: MockFn;
  showModal: MockFn;
  followUp: MockFn;
  /** Autocomplete respond() */
  respond: MockFn;
  deleteReply: MockFn;

  // ── State flags ────────────────────────────────────────────────────────────
  /** True after reply() has been called */
  replied: boolean;
  /** True after deferReply() / deferUpdate() has been called */
  deferred: boolean;

  // ── Discord client ─────────────────────────────────────────────────────────
  client: {
    guilds: {
      fetch: (
        id: string
      ) => Promise<{ roles: { fetch: (id: string) => Promise<{ name: string } | null> } } | null>;
    };
  };

  // ── Webhook (used to edit active verify panels) ────────────────────────────
  webhook: {
    editMessage: MockFn;
    deleteMessage: MockFn;
  };

  // ── Interaction type guards ────────────────────────────────────────────────
  isChatInputCommand(): boolean;
  isButton(): boolean;
  isModalSubmit(): boolean;
  isStringSelectMenu(): boolean;
  isRoleSelectMenu(): boolean;
  isUserSelectMenu(): boolean;
  isChannelSelectMenu(): boolean;
  isAutocomplete(): boolean;
  isFromMessage(): boolean;
  isRepliable(): boolean;
  inGuild(): boolean;
}

// ─── Factory option types ─────────────────────────────────────────────────────

export interface MockSlashCommandOpts {
  userId?: string;
  username?: string;
  displayName?: string;
  guildId?: string | null;
  commandName?: string;
  subcommand?: string | null;
  subcommandGroup?: string | null;
  /** When true, member.permissions.has() returns true for any bit */
  isAdmin?: boolean;
  stringOptions?: Record<string, string | null>;
  userOptions?: Record<string, { id: string; username: string } | null>;
  mentionableOptions?: Record<string, unknown>;
  booleanOptions?: Record<string, boolean | null>;
  /** The focused autocomplete option */
  focusedOption?: { name: string; value: string };
}

export interface MockButtonOpts {
  userId?: string;
  username?: string;
  displayName?: string;
  guildId?: string | null;
  customId?: string;
  isAdmin?: boolean;
}

export interface MockModalSubmitOpts {
  userId?: string;
  username?: string;
  displayName?: string;
  guildId?: string | null;
  customId?: string;
  textInputValues?: Record<string, string>;
  /** Simulates interaction.isFromMessage() returning true */
  fromMessage?: boolean;
}

export interface MockStringSelectOpts {
  userId?: string;
  username?: string;
  displayName?: string;
  guildId?: string | null;
  customId?: string;
  values?: string[];
  isAdmin?: boolean;
}

// ─── Internal base builder ────────────────────────────────────────────────────

function buildBase(
  userId: string,
  username: string,
  displayName: string,
  guildId: string | null,
  isAdmin: boolean
): MockInteraction {
  return {
    user: {
      id: userId,
      username,
      displayName,
      displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    },
    applicationId: 'mock_app_id',
    token: 'mock_interaction_token',

    guildId,
    guild: guildId
      ? {
          roles: {
            fetch: () => Promise.resolve(null),
          },
        }
      : null,
    channel: {
      send: mock(() => Promise.resolve({ id: 'mock_message_id' })),
    },
    member: {
      permissions: {
        has: (_bit: bigint) => isAdmin,
      },
    },

    commandName: '',
    customId: '',
    values: [],

    options: {
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
      getString: () => null,
      getUser: () => null,
      getMentionable: () => null,
      getBoolean: () => null,
      getFocused: () => ({ name: '', value: '' }),
    },

    fields: {
      getTextInputValue: () => '',
    },

    reply: mock(() => Promise.resolve(undefined)),
    deferReply: mock(() => Promise.resolve(undefined)),
    deferUpdate: mock(() => Promise.resolve(undefined)),
    editReply: mock(() => Promise.resolve({ id: 'mock_message_id' })),
    update: mock(() => Promise.resolve(undefined)),
    showModal: mock(() => Promise.resolve(undefined)),
    followUp: mock(() => Promise.resolve({ id: 'mock_followup_id' })),
    respond: mock(() => Promise.resolve(undefined)),
    deleteReply: mock(() => Promise.resolve(undefined)),

    replied: false,
    deferred: false,

    client: {
      guilds: {
        fetch: () => Promise.resolve(null),
      },
    },

    webhook: {
      editMessage: mock(() => Promise.resolve({ id: 'mock_message_id' })),
      deleteMessage: mock(() => Promise.resolve(undefined)),
    },

    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isAutocomplete: () => false,
    isFromMessage: () => false,
    isRepliable: () => true,
    inGuild: () => guildId !== null,
  };
}

// ─── Factory functions ────────────────────────────────────────────────────────

/** Create a slash command (ChatInputCommandInteraction) mock */
export function mockSlashCommand(opts: MockSlashCommandOpts = {}): MockInteraction {
  const {
    userId = 'user_123',
    username = 'testuser',
    displayName = 'Test User',
    guildId = 'guild_123',
    commandName = 'creator',
    subcommand = null,
    subcommandGroup = null,
    isAdmin = false,
    stringOptions = {},
    userOptions = {},
    mentionableOptions = {},
    booleanOptions = {},
    focusedOption = { name: '', value: '' },
  } = opts;

  const base = buildBase(userId, username, displayName, guildId, isAdmin);

  return {
    ...base,
    commandName,
    options: {
      getSubcommand: (_required?: boolean) => subcommand,
      getSubcommandGroup: (_required?: boolean) => subcommandGroup,
      getString: (name: string) => stringOptions[name] ?? null,
      getUser: (name: string) => userOptions[name] ?? null,
      getMentionable: (name: string) => mentionableOptions[name] ?? null,
      getBoolean: (name: string) => booleanOptions[name] ?? null,
      getFocused: () => focusedOption,
    },
    isChatInputCommand: () => true,
  };
}

/** Create a button interaction (ButtonInteraction) mock */
export function mockButton(opts: MockButtonOpts = {}): MockInteraction {
  const {
    userId = 'user_123',
    username = 'testuser',
    displayName = 'Test User',
    guildId = 'guild_123',
    customId = 'mock_button',
    isAdmin = false,
  } = opts;

  const base = buildBase(userId, username, displayName, guildId, isAdmin);

  return {
    ...base,
    customId,
    isButton: () => true,
  };
}

/** Create a modal submit interaction (ModalSubmitInteraction) mock */
export function mockModalSubmit(opts: MockModalSubmitOpts = {}): MockInteraction {
  const {
    userId = 'user_123',
    username = 'testuser',
    displayName = 'Test User',
    guildId = 'guild_123',
    customId = 'mock_modal',
    textInputValues = {},
    fromMessage = false,
  } = opts;

  const base = buildBase(userId, username, displayName, guildId, false);

  return {
    ...base,
    customId,
    fields: {
      getTextInputValue: (fieldId: string) => textInputValues[fieldId] ?? '',
    },
    isModalSubmit: () => true,
    isFromMessage: () => fromMessage,
  };
}

/** Create a string select menu interaction (StringSelectMenuInteraction) mock */
export function mockStringSelect(opts: MockStringSelectOpts = {}): MockInteraction {
  const {
    userId = 'user_123',
    username = 'testuser',
    displayName = 'Test User',
    guildId = 'guild_123',
    customId = 'mock_select',
    values = [],
    isAdmin = false,
  } = opts;

  const base = buildBase(userId, username, displayName, guildId, isAdmin);

  return {
    ...base,
    customId,
    values,
    isStringSelectMenu: () => true,
  };
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

type ResponsePayload = {
  embeds?: unknown[];
  components?: Array<{ components?: unknown[] }>;
};

/** Collect the first argument from every response-method call */
function collectPayloads(interaction: MockInteraction): ResponsePayload[] {
  return [
    ...interaction.reply.mock.calls,
    ...interaction.editReply.mock.calls,
    ...interaction.followUp.mock.calls,
    ...interaction.update.mock.calls,
  ].map((call) => (call[0] as ResponsePayload | undefined) ?? {});
}

/** Return the first embed from the first reply() call */
export function getEmbedFromReply(interaction: MockInteraction): unknown {
  const calls = interaction.reply.mock.calls as Array<[ResponsePayload]>;
  return calls[0]?.[0]?.embeds?.[0];
}

/** Return the first embed from the first editReply() call */
export function getEmbedFromEditReply(interaction: MockInteraction): unknown {
  const calls = interaction.editReply.mock.calls as Array<[ResponsePayload]>;
  return calls[0]?.[0]?.embeds?.[0];
}

type ComponentWithData = { data?: { type?: number; custom_id?: string } };

/**
 * Return all button components (ComponentType.Button = 2) found across every
 * component row in every response method call.
 */
export function getAllButtons(interaction: MockInteraction): ComponentWithData[] {
  const buttons: ComponentWithData[] = [];
  for (const payload of collectPayloads(interaction)) {
    for (const row of payload.components ?? []) {
      for (const comp of row.components ?? []) {
        const c = comp as ComponentWithData;
        if (c.data?.type === 2) {
          buttons.push(c);
        }
      }
    }
  }
  return buttons;
}

/**
 * Return every `custom_id` value found across all component rows in every
 * response method call (buttons + select menus, excludes link buttons).
 */
export function extractAllCustomIds(interaction: MockInteraction): string[] {
  const ids: string[] = [];
  for (const payload of collectPayloads(interaction)) {
    for (const row of payload.components ?? []) {
      for (const comp of row.components ?? []) {
        const customId = (comp as ComponentWithData).data?.custom_id;
        if (customId) {
          ids.push(customId);
        }
      }
    }
  }
  return ids;
}
