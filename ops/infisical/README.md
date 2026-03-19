# Infisical Secret Management

This directory contains documentation and templates for managing secrets with [Infisical](https://infisical.com).

## Project Structure

Three environments are configured:

| Environment | Project Slug | Purpose |
|-------------|--------------|---------|
| `dev` | `gumroad-dev` | Local development, feature branches |
| `preview` | `gumroad-preview` | PR previews, staging deployments |
| `prod` | `gumroad-prod` | Production workloads |

## Secret Paths

Secrets are organized by service and access scope:

```
/                    # Root - admin only
├── api/             # API service secrets
│   ├── auth/        # Authentication secrets (Better Auth, OAuth)
│   ├── database/    # Database connection strings
│   └── integrations/# Third-party integrations (Gumroad, Jinxxy, Email)
├── bot/             # Discord bot secrets
│   └── discord/     # Discord-specific credentials
└── infra/           # Infrastructure secrets
    ├── convex/      # Convex deployment
    └── signing/     # Webhook signing keys
```

## Service Identities

Each service has its own machine identity with least-privilege access:

| Identity | Environments | Paths | Purpose |
|----------|--------------|-------|---------|
| `api-dev` | dev | /api/*, /infra/* | Local API development |
| `api-preview` | preview | /api/*, /infra/* | Preview deployments |
| `api-prod` | prod | /api/*, /infra/* | Production API |
| `bot-dev` | dev | /bot/* | Local bot development |
| `bot-preview` | preview | /bot/* | Preview bot |
| `bot-prod` | prod | /bot/* | Production bot |
| `ci-cd` | dev, preview, prod | Read-only all | CI/CD pipeline |
| `admin` | dev, preview, prod | All | Administrators only |

## Required Secrets

### Discord Integration (`/bot/discord/` and `/api/auth/discord/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `DISCORD_BOT_TOKEN` | Bot authentication token | On compromise / 90 days |
| `DISCORD_CLIENT_ID` | OAuth client ID | Never (public) |
| `DISCORD_CLIENT_SECRET` | OAuth client secret | On compromise / 90 days |
| `DISCORD_PUBLIC_KEY` | Interaction endpoint public key | On compromise |

### Gumroad Integration (`/api/integrations/gumroad/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `GUMROAD_CLIENT_ID` | OAuth client ID | Never (public) |
| `GUMROAD_CLIENT_SECRET` | OAuth client secret | On compromise / 90 days |

### Jinxxy Integration (`/api/integrations/jinxxy/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `JINXXY_API_KEY` | API key for Jinxxy | On compromise / 90 days |

### Email (`/api/integrations/email/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `RESEND_API_KEY` | Resend API key for transactional emails | On compromise / 90 days |
| `EMAIL_FROM` | From address (e.g. `Creator Assistant <noreply@yourdomain.com>`) | On domain change |

### Authentication (`/api/auth/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `BETTER_AUTH_SECRET` | Session encryption key | On compromise / 180 days |
| `ERROR_REFERENCE_SECRET` | Optional dedicated key for verification support-code encryption | On compromise / 180 days |
| `DATABASE_URL` | PostgreSQL connection string | On credential change |

### Infrastructure (`/infra/`)

| Secret Key | Description | Rotation |
|------------|-------------|----------|
| `CONVEX_URL` | Convex deployment URL | Never (public-ish) |
| `CONVEX_DEPLOY_KEY` | Convex deployment token | On compromise / 90 days |
| `INTERNAL_RPC_SHARED_SECRET` | Shared bearer secret for web, API, and bot internal RPC/authenticated proxy calls. Required in production, optional in local dev because services share a built-in dev secret. | On compromise / 90 days |
| `WEBHOOK_SIGNING_SECRET` | Webhook signature key | On compromise / 90 days |

## Environment Variable Mapping

### API Service

```bash
# Auth
BETTER_AUTH_SECRET=/api/auth/BETTER_AUTH_SECRET
ERROR_REFERENCE_SECRET=/api/auth/ERROR_REFERENCE_SECRET
DATABASE_URL=/api/database/DATABASE_URL

# Discord OAuth
DISCORD_CLIENT_ID=/api/auth/discord/DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET=/api/auth/discord/DISCORD_CLIENT_SECRET

# Integrations
GUMROAD_CLIENT_ID=/api/integrations/gumroad/GUMROAD_CLIENT_ID
GUMROAD_CLIENT_SECRET=/api/integrations/gumroad/GUMROAD_CLIENT_SECRET
JINXXY_API_KEY=/api/integrations/jinxxy/JINXXY_API_KEY
RESEND_API_KEY=/api/integrations/email/RESEND_API_KEY
EMAIL_FROM=/api/integrations/email/EMAIL_FROM

# Infrastructure
CONVEX_URL=/infra/convex/CONVEX_URL
INTERNAL_RPC_SHARED_SECRET=/infra/signing/INTERNAL_RPC_SHARED_SECRET
WEBHOOK_SIGNING_SECRET=/infra/signing/WEBHOOK_SIGNING_SECRET
```

### Bot Service

```bash
# Discord
DISCORD_BOT_TOKEN=/bot/discord/DISCORD_BOT_TOKEN
DISCORD_PUBLIC_KEY=/bot/discord/DISCORD_PUBLIC_KEY
DISCORD_CLIENT_ID=/bot/discord/DISCORD_CLIENT_ID

# Infrastructure
CONVEX_URL=/infra/convex/CONVEX_URL
INTERNAL_RPC_SHARED_SECRET=/infra/signing/INTERNAL_RPC_SHARED_SECRET
```

## CLI Usage

### Local Development

```bash
# Install Infisical CLI
brew install infisical/get-cli/infisical

# Login with machine identity
export INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id=$INFISICAL_CLIENT_ID \
  --client-secret=$INFISICAL_CLIENT_SECRET \
  --silent --plain)

# Run with secrets injected
infisical run --env=dev --path=/api -- bun run dev

# Export secrets to .env (for IDE support)
infisical export --env=dev --path=/api --format=dotenv-export > .env.local
```

### CI/CD Pipeline

```bash
# Using Universal Auth
export INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id=$INFISICAL_CLIENT_ID \
  --client-secret=$INFISICAL_CLIENT_SECRET \
  --silent --plain)

# Run deployment with secrets
infisical run --env=$ENVIRONMENT --path=/api -- ./deploy.sh
```

## Secret Rotation Runbooks

### Rotation Schedule

| Secret Type | Frequency | Automation |
|-------------|-----------|------------|
| OAuth secrets | 90 days | Manual with automation assist |
| API keys | 90 days | Manual with automation assist |
| Session secrets | 180 days | Manual, requires logout all |
| Signing keys | 90 days | Manual with webhook re-registration |

### Discord Bot Token Rotation

1. Navigate to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select the application → Bot → Reset Token
3. Copy new token immediately
4. Update in Infisical: `/bot/discord/DISCORD_BOT_TOKEN`
5. Redeploy bot service
6. Verify bot connects successfully
7. Mark old token as compromised (cannot be revoked separately)

### Discord Client Secret Rotation

1. Navigate to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select the application → OAuth2 → Reset Secret
3. Copy new secret immediately
4. Update in Infisical: `/api/auth/discord/DISCORD_CLIENT_SECRET`
5. Redeploy API service
6. Test OAuth flow
7. Old secret is immediately invalid

### Better Auth Secret Rotation

1. Generate new 32-byte secret: `openssl rand -base64 32`
2. Store new secret temporarily
3. Update in Infisical: `/api/auth/BETTER_AUTH_SECRET`
4. **IMPORTANT**: This will invalidate all existing sessions
5. Redeploy API service
6. Users must re-authenticate
7. Consider announcing maintenance window

### Gumroad Client Secret Rotation

1. Navigate to [Gumroad Settings](https://gumroad.com/settings)
2. Advanced → OAuth Applications → Regenerate Secret
3. Update in Infisical: `/api/integrations/gumroad/GUMROAD_CLIENT_SECRET`
4. Redeploy API service
5. Test OAuth flow with Gumroad

### Jinxxy API Key Rotation

1. Log into Jinxxy dashboard
2. Generate new API key
3. Update in Infisical: `/api/integrations/jinxxy/JINXXY_API_KEY`
4. Redeploy API service
5. Test integration
6. Revoke old key in Jinxxy dashboard

### Webhook Signing Secret Rotation

1. Generate new secret: `openssl rand -hex 32`
2. Update in Infisical: `/infra/signing/WEBHOOK_SIGNING_SECRET`
3. Update webhook registrations in Discord Developer Portal
4. Redeploy all services that handle webhooks
5. Test webhook signature verification

## Security Best Practices

1. **Never commit secrets to git** - Use `.gitignore` for `.env*` files
2. **Use least-privilege access** - Services only access paths they need
3. **Rotate on compromise** - Any suspected leak requires immediate rotation
4. **Audit access logs** - Review Infisical audit logs weekly
5. **Separate environments** - No shared secrets between dev/preview/prod
6. **Short-lived tokens** - CI/CD tokens should have minimal TTL
7. **No secrets in logs** - Ensure logging doesn't capture secret values

## Files

- `secrets.template.yaml` - Template showing all required secrets with placeholder values
- `access-policy.yaml` - Access control policy definitions for service identities

## Decoding Verification Support Codes

When a user reports a verification support code, decode it locally with:

```bash
bun ops/decode-support-token.ts <support-code>
```

The script uses `ERROR_REFERENCE_SECRET` when present and falls back to `BETTER_AUTH_SECRET`. If those env vars are not already loaded, it will make a best-effort Infisical fetch first.
