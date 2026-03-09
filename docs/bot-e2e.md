# Discord Bot E2E

This repository now has a real-infrastructure Discord bot E2E lane at `bun run test:bot:e2e`.

## What it does

- Boots the API and bot from source.
- Uses a real Discord bot token and real guild command registration.
- Uses Playwright browser contexts backed by real Discord user storage state.
- Provisions channels, roles, role rules, entitlements, and download routes through the real Discord and Convex APIs.
- Persists a cleanup manifest under `apps/bot/test/e2e/.artifacts/`.

## Required environment

Populate the variables in [.env.bot-e2e.example](/Users/svalp/OneDrive/Documents/Development/Gumroad/.env.bot-e2e.example) with dedicated test credentials.

Required core secrets:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `CONVEX_URL`
- `CONVEX_API_SECRET`
- `API_BASE_URL`
- `API_INTERNAL_URL`
- `FRONTEND_URL`
- `BETTER_AUTH_SECRET`
- `BOT_E2E_TARGET_GUILD_ID`
- `BOT_E2E_SOURCE_GUILD_ID`
- `BOT_E2E_TENANT_ID`
- `BOT_E2E_GUILD_LINK_ID`
- `BOT_E2E_ADMIN_USER_ID`
- `BOT_E2E_MEMBER_USER_ID`
- `BOT_E2E_ADMIN_STORAGE_STATE_B64`
- `BOT_E2E_MEMBER_STORAGE_STATE_B64`

Required provider fixtures:

- `BOT_E2E_GUMROAD_PRODUCT_URL`
- `BOT_E2E_GUMROAD_TEST_PURCHASER`
- `BOT_E2E_JINXXY_PRODUCT_ID`
- `BOT_E2E_JINXXY_LICENSE_KEY`
- `BOT_E2E_COLLAB_JINXXY_API_KEY`

## Dedicated Discord setup

- Create a dedicated Discord application and bot.
- Install the bot in both the target guild and the source guild.
- Ensure the bot has the permissions used by the bot itself:
  `Manage Roles`, `Manage Messages`, `Manage Webhooks`, `Manage Threads`,
  `Create Public Threads`, `Send Messages`, `Send Messages in Threads`,
  `View Channel`, `Read Message History`, `Attach Files`, and `Embed Links`.
- Keep the bot role above the test roles it needs to assign.
- Provision one target guild for the main product/download tests and one source guild for cross-server role verification.

## Discord user storage state

The E2E suite does not use fake Discord users and does not automate fresh logins.
It expects pre-recorded Playwright storage state for:

- one admin user that can run `/creator-admin`
- one member user for verification and download flows

Create each storage state with the capture script (uses Node/tsx because Bun + Playwright hangs on Windows):

```powershell
bun run capture:discord-storage -- --out admin-storage-state.json
```

Log in to Discord in the opened browser, wait for it to load, then press Enter in the terminal. Base64-encode the result:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("admin-storage-state.json"))
```

Store the resulting values in `BOT_E2E_ADMIN_STORAGE_STATE_B64` and `BOT_E2E_MEMBER_STORAGE_STATE_B64`.

## Running locally

```powershell
bun install
bunx playwright install chromium
bun run test:bot:e2e
```

## Running in CI

Use the dedicated workflow in [.github/workflows/bot-e2e.yml](/Users/svalp/OneDrive/Documents/Development/Gumroad/.github/workflows/bot-e2e.yml). It installs Chromium and runs only the bot E2E lane.

## Current scenario coverage

- API and bot boot from source.
- Slash command registration in the target guild.
- Real `/creator status`, `/creator docs`, and public verify-button entry from Discord Web.
- Real `/creator-admin stats`, `/creator-admin analytics`, `/creator-admin setup start`, and `/creator-admin spawn-verify` command execution from Discord Web.
- Real `/creator-admin settings cross-server` enable and disable actions, asserted against tenant policy state.
- Real cross-server role sync using a source-guild role and `/creator refresh`.
- Real `/creator refresh` role sync against Convex and Discord roles.
- Real Liened Downloads upload, archive creation, button gating, and `/creator-admin downloads manage` toggle and remove flow.
- Real `/creator-admin collab invite`, manual collaborator connection listing, and removal flow.
- Real `/creator-admin moderation list` against a live suspicious-subject mutation.

The suite is intentionally strict. If a required secret or provider fixture is missing, it should fail loudly instead of silently downgrading to mocks or skips.
