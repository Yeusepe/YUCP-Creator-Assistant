import { errorResponse, generateRequestId } from './helpers';
import type { PublicV2Config } from './types';

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'YUCP Public API',
    version: '2025-03-01',
    description:
      'The YUCP Public API gives creators programmatic access to their verification platform data. Modeled after Stripe/Paddle. All responses include standard headers: `X-Request-Id`, `Yucp-Version`, `RateLimit-*`.',
    contact: {
      name: 'YUCP Support',
      url: 'https://yucp.io/support',
    },
  },
  servers: [
    {
      url: 'https://api.creators.yucp.club/api/public/v2',
      description: 'Production',
    },
  ],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'OAuth 2.0 access token',
      },
      apiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API key starting with `ypsk_`',
      },
    },
    parameters: {
      limitParam: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        description: 'Number of items to return (max 100).',
      },
      startingAfterParam: {
        name: 'starting_after',
        in: 'query',
        schema: { type: 'string' },
        description: 'Cursor for forward pagination (opaque, from `nextCursor` field).',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Machine-readable error code.' },
          message: { type: 'string', description: 'Human-readable error description.' },
          requestId: { type: 'string', description: 'Unique request ID for support.' },
          status: { type: 'integer', description: 'HTTP status code.' },
        },
        required: ['error', 'message', 'requestId', 'status'],
      },
      ListMeta: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['list'] },
          hasMore: { type: 'boolean' },
          nextCursor: { type: 'string', nullable: true },
        },
        required: ['object', 'hasMore', 'nextCursor'],
      },
      ApiKeyInfo: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['api_key_info'] },
          authUserId: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          keyId: { type: 'string', nullable: true },
          expiresAt: { type: 'integer', nullable: true, description: 'Unix ms timestamp.' },
        },
      },
      Profile: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['profile'] },
          authUserId: { type: 'string' },
          name: { type: 'string', nullable: true },
          image: { type: 'string', nullable: true, format: 'uri' },
        },
        required: ['object', 'authUserId', 'name', 'image'],
      },
      Subject: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          authUserId: { type: 'string', nullable: true },
          primaryDiscordUserId: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['active', 'suspended', 'banned'],
          },
          createdAt: { type: 'integer' },
        },
      },
      Entitlement: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string' },
          productId: { type: 'string' },
          sourceProvider: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'revoked', 'expired', 'refunded', 'disputed'],
          },
          grantedAt: { type: 'integer' },
          revokedAt: { type: 'integer', nullable: true },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string' },
          provider: { type: 'string' },
          status: { type: 'string' },
          amount: { type: 'integer', description: 'Amount in smallest currency unit.' },
          currency: { type: 'string' },
          purchasedAt: { type: 'integer' },
        },
      },
      Membership: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string' },
          provider: { type: 'string' },
          status: { type: 'string' },
          currentPeriodStart: { type: 'integer', nullable: true },
          currentPeriodEnd: { type: 'integer', nullable: true },
        },
      },
      ProviderLicense: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string' },
          provider: { type: 'string' },
          licenseKey: { type: 'string' },
          status: { type: 'string' },
        },
      },
      ManualLicense: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          productId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'revoked', 'expired', 'exhausted'],
          },
          maxUses: { type: 'integer', nullable: true },
          useCount: { type: 'integer' },
          expiresAt: { type: 'integer', nullable: true },
          notes: { type: 'string', nullable: true },
          buyerEmail: { type: 'string', nullable: true },
          createdAt: { type: 'integer' },
        },
      },
      ManualLicenseStats: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          active: { type: 'integer' },
          revoked: { type: 'integer' },
          expired: { type: 'integer' },
          exhausted: { type: 'integer' },
        },
      },
      Product: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          provider: { type: 'string' },
          providerProductId: { type: 'string' },
          name: { type: 'string', nullable: true },
          status: { type: 'string' },
        },
      },
      Connection: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          provider: { type: 'string' },
          status: { type: 'string' },
          label: { type: 'string', nullable: true },
          connectedAt: { type: 'integer', nullable: true },
        },
      },
      Guild: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          discordGuildId: { type: 'string' },
          discordGuildName: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['active', 'uninstalled', 'suspended'],
          },
        },
      },
      RoleRule: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          guildId: { type: 'string', nullable: true },
          productId: { type: 'string', nullable: true },
          discordRoleId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      Binding: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string' },
          productId: { type: 'string' },
          bindingType: {
            type: 'string',
            enum: ['ownership', 'verification', 'manual_override'],
          },
          status: {
            type: 'string',
            enum: ['pending', 'active', 'revoked', 'transferred', 'quarantined'],
          },
        },
      },
      VerificationSession: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subjectId: { type: 'string', nullable: true },
          mode: { type: 'string' },
          status: { type: 'string' },
          expiresAt: { type: 'integer' },
          createdAt: { type: 'integer' },
        },
      },
      VerificationIntentCapabilityInput: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['license_key'] },
          label: { type: 'string' },
          placeholder: { type: 'string', nullable: true },
          masked: { type: 'boolean' },
          submitLabel: { type: 'string' },
        },
        required: ['kind', 'label', 'masked', 'submitLabel'],
      },
      VerificationIntentCapability: {
        type: 'object',
        properties: {
          methodKind: {
            type: 'string',
            enum: ['existing_entitlement', 'manual_license', 'buyer_provider_link'],
          },
          completion: { type: 'string', enum: ['immediate', 'deferred'] },
          actionLabel: { type: 'string' },
          input: {
            allOf: [{ $ref: '#/components/schemas/VerificationIntentCapabilityInput' }],
            nullable: true,
          },
        },
        required: ['methodKind', 'completion', 'actionLabel'],
      },
      VerificationIntentRequirementInput: {
        type: 'object',
        properties: {
          methodKey: { type: 'string' },
          providerKey: {
            type: 'string',
            description:
              "Verification provider key. Use a provider registry key such as 'gumroad' or 'jinxxy' for marketplace-backed methods. For 'existing_entitlement', internal YUCP account checks may use 'yucp'.",
          },
          kind: {
            type: 'string',
            enum: ['existing_entitlement', 'manual_license', 'buyer_provider_link'],
          },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          creatorAuthUserId: { type: 'string', nullable: true },
          productId: { type: 'string', nullable: true },
          providerProductRef: { type: 'string', nullable: true },
        },
        required: ['methodKey', 'providerKey', 'kind', 'title'],
      },
      VerificationIntentRequirement: {
        type: 'object',
        properties: {
          methodKey: { type: 'string' },
          providerKey: {
            type: 'string',
            description:
              "Verification provider key. Internal entitlement checks may return 'yucp' when the requirement uses the signed-in YUCP buyer account rather than an external marketplace account.",
          },
          providerLabel: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['existing_entitlement', 'manual_license', 'buyer_provider_link'],
          },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          creatorAuthUserId: { type: 'string', nullable: true },
          productId: { type: 'string', nullable: true },
          providerProductRef: { type: 'string', nullable: true },
          capability: { $ref: '#/components/schemas/VerificationIntentCapability' },
        },
        required: ['methodKey', 'providerKey', 'providerLabel', 'kind', 'title', 'capability'],
      },
      VerificationIntent: {
        type: 'object',
        description:
          'A hosted buyer verification attempt for one package and one public-client installation. Public clients should create an intent, open the hosted verification URL in the browser, then redeem the returned short-lived grant.',
        properties: {
          object: { type: 'string', enum: ['verification_intent'] },
          id: { type: 'string' },
          packageId: { type: 'string' },
          packageName: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['pending', 'verified', 'redeemed', 'failed', 'expired', 'cancelled'],
          },
          verificationUrl: {
            type: 'string',
            format: 'uri',
            description: 'Hosted buyer verification URL to open in the system browser.',
          },
          returnUrl: {
            type: 'string',
            format: 'uri',
            description:
              'Client-provided return URL, typically a loopback callback for native apps.',
          },
          requirements: {
            type: 'array',
            items: { $ref: '#/components/schemas/VerificationIntentRequirement' },
          },
          verifiedMethodKey: { type: 'string', nullable: true },
          errorCode: { type: 'string', nullable: true },
          errorMessage: { type: 'string', nullable: true },
          grantToken: {
            type: 'string',
            nullable: true,
            description:
              'Short-lived signed completion grant. Present only after the server verifies the buyer and before redemption.',
          },
          grantAvailable: { type: 'boolean' },
          expiresAt: { type: 'integer', description: 'Unix ms timestamp.' },
          createdAt: { type: 'integer', description: 'Unix ms timestamp.' },
          updatedAt: { type: 'integer', description: 'Unix ms timestamp.' },
        },
        required: [
          'object',
          'id',
          'packageId',
          'status',
          'verificationUrl',
          'returnUrl',
          'requirements',
          'grantAvailable',
          'expiresAt',
          'createdAt',
          'updatedAt',
        ],
      },
      VerificationIntentCreateRequest: {
        type: 'object',
        properties: {
          packageId: { type: 'string' },
          packageName: { type: 'string', nullable: true },
          machineFingerprint: { type: 'string' },
          codeChallenge: {
            type: 'string',
            description: 'PKCE-style SHA-256 code challenge derived from a client-held verifier.',
          },
          returnUrl: {
            type: 'string',
            format: 'uri',
            description: 'Absolute HTTPS or loopback HTTP callback URL for the public client.',
          },
          idempotencyKey: { type: 'string', nullable: true },
          requirements: {
            type: 'array',
            items: { $ref: '#/components/schemas/VerificationIntentRequirementInput' },
          },
        },
        required: ['packageId', 'machineFingerprint', 'codeChallenge', 'returnUrl', 'requirements'],
      },
      VerificationIntentRedeemRequest: {
        type: 'object',
        properties: {
          codeVerifier: { type: 'string' },
          machineFingerprint: { type: 'string' },
          grantToken: { type: 'string' },
        },
        required: ['codeVerifier', 'machineFingerprint', 'grantToken'],
      },
      VerificationRedemption: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['verification_redemption'] },
          success: { type: 'boolean' },
          token: { type: 'string' },
          expiresAt: { type: 'integer', description: 'Unix seconds timestamp.' },
        },
        required: ['object', 'success', 'token', 'expiresAt'],
      },
      Collaborator: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          provider: { type: 'string' },
          status: { type: 'string' },
          collaboratorId: { type: 'string', nullable: true },
        },
      },
      DownloadRoute: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          guildId: { type: 'string' },
          channelId: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
        },
      },
      DownloadArtifact: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          routeId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'deleted', 'failed'],
          },
          filename: { type: 'string', nullable: true },
        },
      },
      Settings: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          authUserId: { type: 'string' },
          policy: { type: 'object', description: 'Tenant policy configuration.' },
        },
      },
      Event: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          eventType: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string' },
          data: { type: 'object' },
          createdAt: { type: 'integer' },
        },
      },
      AuditEvent: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          eventType: { type: 'string' },
          actorType: { type: 'string' },
          actorId: { type: 'string', nullable: true },
          subjectId: { type: 'string', nullable: true },
          metadata: { type: 'object' },
          createdAt: { type: 'integer' },
        },
      },
      WebhookSubscription: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          events: { type: 'array', items: { type: 'string' } },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          signingSecretPrefix: {
            type: 'string',
            description: 'First 8 characters of the signing secret for identification.',
          },
          signingSecret: {
            type: 'string',
            description:
              'Returned ONLY on create and rotate-secret. Store this value securely — it will not be shown again.',
          },
          createdAt: { type: 'integer' },
        },
      },
      WebhookDelivery: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          subscriptionId: { type: 'string' },
          eventType: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
          statusCode: { type: 'integer', nullable: true },
          attemptedAt: { type: 'integer', nullable: true },
        },
      },
      WebhookEventType: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          description: { type: 'string' },
        },
      },
      VerificationStatus: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['verification_status'] },
          authUserId: { type: 'string' },
          subject: { $ref: '#/components/schemas/Subject', nullable: true },
          entitlements: { type: 'array', items: { $ref: '#/components/schemas/Entitlement' } },
        },
      },
      VerificationCheck: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['verification_check'] },
          subject: { $ref: '#/components/schemas/Subject', nullable: true },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
                entitled: { type: 'boolean' },
                entitlement: {
                  $ref: '#/components/schemas/Entitlement',
                  nullable: true,
                },
              },
            },
          },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid authentication credentials.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      },
      Forbidden: {
        description: 'Insufficient scopes for this operation.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      },
      NotFound: {
        description: 'The requested resource was not found.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      },
      InternalError: {
        description: 'An unexpected server error occurred.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      },
    },
  },
  paths: {
    '/me': {
      get: {
        operationId: 'getMe',
        summary: 'Get current API identity',
        description: 'Returns the authenticated caller identity and granted scopes.',
        tags: ['Identity'],
        responses: {
          '200': {
            description: 'Current API key or token identity.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiKeyInfo' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/me/profile': {
      get: {
        operationId: 'getMyProfile',
        summary: 'Get current user profile',
        description:
          'Returns the authenticated user profile used across YUCP account surfaces. Requires the `profile:read` scope.',
        tags: ['Identity'],
        security: [{ bearerAuth: ['profile:read'] }, { apiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Authenticated user profile.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Profile' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': {
            description: 'Profile not found.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },

    '/subjects': {
      get: {
        operationId: 'listSubjects',
        summary: 'List subjects',
        description: 'Returns a paginated list of subjects (buyers/users) for the tenant.',
        tags: ['Subjects'],
        security: [{ bearerAuth: ['subjects:read'] }, { apiKeyHeader: [] }],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'suspended', 'banned'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Search query.',
          },
        ],
        responses: {
          '200': {
            description: 'List of subjects.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Subject' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/subjects/{id}': {
      get: {
        operationId: 'getSubject',
        summary: 'Get a subject',
        tags: ['Subjects'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Subject object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Subject' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/subjects/{id}/entitlements': {
      get: {
        operationId: 'listSubjectEntitlements',
        summary: 'List entitlements for a subject',
        tags: ['Subjects', 'Entitlements'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': {
            description: 'Paginated entitlements for the subject.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Entitlement' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/subjects/{id}/transactions': {
      get: {
        operationId: 'listSubjectTransactions',
        summary: 'List transactions for a subject',
        tags: ['Subjects', 'Transactions'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': {
            description: 'Paginated transactions.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Transaction' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/subjects/{id}/memberships': {
      get: {
        operationId: 'listSubjectMemberships',
        summary: 'List memberships for a subject',
        tags: ['Subjects', 'Transactions'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': {
            description: 'Paginated memberships.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Membership' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/subjects/{id}/bindings': {
      get: {
        operationId: 'listSubjectBindings',
        summary: 'List bindings for a subject',
        tags: ['Subjects', 'Bindings'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': {
            description: 'Paginated bindings.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Binding' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/entitlements': {
      get: {
        operationId: 'listEntitlements',
        summary: 'List entitlements',
        tags: ['Entitlements'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
          { name: 'product_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['active', 'revoked', 'expired', 'refunded', 'disputed'],
            },
          },
          { name: 'source_provider', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated entitlements.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Entitlement' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/entitlements/{id}': {
      get: {
        operationId: 'getEntitlement',
        summary: 'Get an entitlement',
        tags: ['Entitlements'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Entitlement object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Entitlement' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/transactions': {
      get: {
        operationId: 'listTransactions',
        summary: 'List transactions',
        tags: ['Transactions'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated transactions.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Transaction' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/transactions/{id}': {
      get: {
        operationId: 'getTransaction',
        summary: 'Get a transaction',
        tags: ['Transactions'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Transaction object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Transaction' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/memberships': {
      get: {
        operationId: 'listMemberships',
        summary: 'List memberships',
        tags: ['Transactions'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated memberships.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Membership' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/memberships/{id}': {
      get: {
        operationId: 'getMembership',
        summary: 'Get a membership',
        tags: ['Transactions'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Membership object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Membership' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/provider-licenses': {
      get: {
        operationId: 'listProviderLicenses',
        summary: 'List provider licenses',
        tags: ['Transactions'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated provider licenses.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/ProviderLicense' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/provider-licenses/{id}': {
      get: {
        operationId: 'getProviderLicense',
        summary: 'Get a provider license',
        tags: ['Transactions'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Provider license object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProviderLicense' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/manual-licenses': {
      get: {
        operationId: 'listManualLicenses',
        summary: 'List manual licenses',
        tags: ['Manual Licenses'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'product_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'revoked', 'expired', 'exhausted'] },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated manual licenses.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/ManualLicense' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        operationId: 'createManualLicense',
        summary: 'Create a manual license',
        description:
          'Creates a manual license. The `key` field is hashed with SHA-256 before storage and is never returned in API responses.',
        tags: ['Manual Licenses'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['key', 'product_id'],
                properties: {
                  key: {
                    type: 'string',
                    description: 'Plaintext license key (hashed before storage).',
                  },
                  product_id: { type: 'string' },
                  max_uses: { type: 'integer', nullable: true },
                  expires_at: {
                    type: 'integer',
                    nullable: true,
                    description: 'Unix ms timestamp.',
                  },
                  notes: { type: 'string', nullable: true },
                  buyer_email: { type: 'string', format: 'email', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created manual license.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ManualLicense' },
              },
            },
          },
          '400': { description: 'Invalid request body.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/manual-licenses/bulk': {
      post: {
        operationId: 'bulkCreateManualLicenses',
        summary: 'Bulk create manual licenses',
        description:
          'Create up to 100 manual licenses in a single request. Keys are hashed before storage.',
        tags: ['Manual Licenses'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['licenses'],
                properties: {
                  licenses: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                      type: 'object',
                      required: ['key', 'product_id'],
                      properties: {
                        key: { type: 'string' },
                        product_id: { type: 'string' },
                        max_uses: { type: 'integer', nullable: true },
                        expires_at: { type: 'integer', nullable: true },
                        notes: { type: 'string', nullable: true },
                        buyer_email: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Bulk create result.' },
          '400': { description: 'Invalid request body or too many licenses.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/manual-licenses/stats': {
      get: {
        operationId: 'getManualLicenseStats',
        summary: 'Get manual license statistics',
        tags: ['Manual Licenses'],
        responses: {
          '200': {
            description: 'Aggregate stats.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ManualLicenseStats' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/manual-licenses/validate': {
      post: {
        operationId: 'validateManualLicense',
        summary: 'Validate a license key',
        description:
          'Validates a license key without consuming a use. The key is hashed before lookup.',
        tags: ['Manual Licenses'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['key'],
                properties: {
                  key: { type: 'string' },
                  product_id: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Validation result.' },
          '400': { description: 'Invalid request body.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/manual-licenses/{id}': {
      get: {
        operationId: 'getManualLicense',
        summary: 'Get a manual license',
        tags: ['Manual Licenses'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Manual license object.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ManualLicense' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/manual-licenses/{id}/revoke': {
      post: {
        operationId: 'revokeManualLicense',
        summary: 'Revoke a manual license',
        tags: ['Manual Licenses'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reason: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Revocation result.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/products': {
      get: {
        operationId: 'listProducts',
        summary: 'List products',
        tags: ['Products'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated products.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/products/{id}': {
      get: {
        operationId: 'getProduct',
        summary: 'Get a product',
        tags: ['Products'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Product object.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Product' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/products/{id}/entitlements': {
      get: {
        operationId: 'listProductEntitlements',
        summary: 'List entitlements for a product',
        tags: ['Products', 'Entitlements'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': { description: 'Paginated entitlements.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/products/{id}/role-rules': {
      get: {
        operationId: 'listProductRoleRules',
        summary: 'List role rules for a product',
        tags: ['Products', 'Role Rules'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Role rules for the product.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/connections': {
      get: {
        operationId: 'listConnections',
        summary: 'List provider connections',
        tags: ['Connections'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated connections.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { $ref: '#/components/schemas/Connection' } },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/connections/{id}': {
      get: {
        operationId: 'getConnection',
        summary: 'Get a connection',
        tags: ['Connections'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Connection object.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Connection' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/guilds': {
      get: {
        operationId: 'listGuilds',
        summary: 'List Discord servers (guilds)',
        tags: ['Guilds'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'uninstalled', 'suspended'] },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated guilds.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { $ref: '#/components/schemas/Guild' } },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/guilds/{id}': {
      get: {
        operationId: 'getGuild',
        summary: 'Get a guild',
        tags: ['Guilds'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Guild object.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Guild' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/guilds/{id}/role-rules': {
      get: {
        operationId: 'listGuildRoleRules',
        summary: 'List role rules for a guild',
        tags: ['Guilds', 'Role Rules'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Role rules for the guild.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/guilds/{id}/downloads': {
      get: {
        operationId: 'listGuildDownloadRoutes',
        summary: 'List download routes for a guild',
        tags: ['Guilds', 'Downloads'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
        ],
        responses: {
          '200': { description: 'Download routes.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/role-rules': {
      get: {
        operationId: 'listRoleRules',
        summary: 'List role rules',
        tags: ['Role Rules'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'guild_id', in: 'query', schema: { type: 'string' } },
          { name: 'product_id', in: 'query', schema: { type: 'string' } },
          { name: 'enabled', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'Paginated role rules.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { $ref: '#/components/schemas/RoleRule' } },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/role-rules/{id}': {
      get: {
        operationId: 'getRoleRule',
        summary: 'Get a role rule',
        tags: ['Role Rules'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Role rule object.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RoleRule' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/bindings': {
      get: {
        operationId: 'listBindings',
        summary: 'List bindings',
        tags: ['Bindings'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['pending', 'active', 'revoked', 'transferred', 'quarantined'],
            },
          },
          {
            name: 'binding_type',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['ownership', 'verification', 'manual_override'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Paginated bindings.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { $ref: '#/components/schemas/Binding' } },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/bindings/{id}': {
      get: {
        operationId: 'getBinding',
        summary: 'Get a binding',
        tags: ['Bindings'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Binding object.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Binding' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/verification-sessions': {
      get: {
        operationId: 'listVerificationSessions',
        summary: 'List verification sessions',
        tags: ['Verification Sessions'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'mode', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated verification sessions.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/VerificationSession' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/verification-sessions/{id}': {
      get: {
        operationId: 'getVerificationSession',
        summary: 'Get a verification session',
        tags: ['Verification Sessions'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Verification session.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationSession' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/verification-intents': {
      post: {
        operationId: 'createVerificationIntent',
        summary: 'Create a hosted verification intent',
        description:
          'Create a hosted buyer verification flow for a public client such as Unity. The client opens the returned `verificationUrl` in the system browser, waits for verification to complete, then redeems the signed completion grant.',
        tags: ['Verification Intents'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerificationIntentCreateRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Created or resumed verification intent.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationIntent' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/verification-intents/{id}': {
      get: {
        operationId: 'getVerificationIntent',
        summary: 'Get a verification intent',
        description:
          'Fetch the current state of a hosted verification intent. Public clients may poll this endpoint lightly while the browser flow is in progress.',
        tags: ['Verification Intents'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Verification intent.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationIntent' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/verification-intents/{id}/redeem': {
      post: {
        operationId: 'redeemVerificationIntent',
        summary: 'Redeem a completed verification intent',
        description:
          'Redeem the short-lived completion grant for the machine-bound access artifact. Public clients must present the original code verifier and the same machine fingerprint used when the intent was created.',
        tags: ['Verification Intents'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerificationIntentRedeemRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Redeemed verification grant.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationRedemption' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '422': {
            description: 'The verification grant or intent state was invalid for redemption.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },

    '/collaborators': {
      get: {
        operationId: 'listCollaborators',
        summary: 'List collaborator connections',
        tags: ['Collaborators'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Paginated collaborators.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/collaborators/{id}': {
      get: {
        operationId: 'getCollaborator',
        summary: 'Get a collaborator',
        tags: ['Collaborators'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Collaborator object.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/downloads/routes': {
      get: {
        operationId: 'listDownloadRoutes',
        summary: 'List download routes',
        tags: ['Downloads'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'guild_id', in: 'query', schema: { type: 'string' } },
          { name: 'enabled', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': { description: 'Paginated download routes.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/downloads/routes/{id}': {
      get: {
        operationId: 'getDownloadRoute',
        summary: 'Get a download route',
        tags: ['Downloads'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Download route object.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/downloads/artifacts': {
      get: {
        operationId: 'listDownloadArtifacts',
        summary: 'List download artifacts',
        tags: ['Downloads'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'route_id', in: 'query', schema: { type: 'string' } },
          { name: 'guild_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'deleted', 'failed'] },
          },
        ],
        responses: {
          '200': { description: 'Paginated artifacts.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/downloads/artifacts/{id}': {
      get: {
        operationId: 'getDownloadArtifact',
        summary: 'Get a download artifact',
        tags: ['Downloads'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Download artifact object.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/settings': {
      get: {
        operationId: 'getSettings',
        summary: 'Get tenant settings',
        tags: ['Settings'],
        responses: {
          '200': {
            description: 'Tenant settings.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Settings' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      patch: {
        operationId: 'updateSettings',
        summary: 'Update tenant settings',
        tags: ['Settings'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Partial policy patch. Only provided fields are updated.',
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated settings.' },
          '400': { description: 'Invalid policy patch.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/events': {
      get: {
        operationId: 'listEvents',
        summary: 'List platform events',
        tags: ['Events'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'resource_id', in: 'query', schema: { type: 'string' } },
          { name: 'resource_type', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Paginated events.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/events/{id}': {
      get: {
        operationId: 'getEvent',
        summary: 'Get an event',
        tags: ['Events'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Event object.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/audit-log': {
      get: {
        operationId: 'listAuditLog',
        summary: 'List audit log entries',
        tags: ['Audit Log'],
        parameters: [
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'subject_id', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Paginated audit log entries.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/webhooks': {
      get: {
        operationId: 'listWebhooks',
        summary: 'List webhook subscriptions',
        tags: ['Webhooks'],
        parameters: [{ name: 'enabled', in: 'query', schema: { type: 'boolean' } }],
        responses: {
          '200': { description: 'Paginated webhook subscriptions.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        operationId: 'createWebhook',
        summary: 'Create a webhook subscription',
        description:
          'Creates a webhook endpoint. The `signingSecret` is returned in this response only — store it securely.',
        tags: ['Webhooks'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  events: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Event types to subscribe to. Empty array = all events.',
                  },
                  description: { type: 'string', nullable: true },
                  enabled: { type: 'boolean', default: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created webhook subscription (includes signingSecret).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookSubscription' },
              },
            },
          },
          '400': { description: 'Invalid request body.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/webhooks/{id}': {
      get: {
        operationId: 'getWebhook',
        summary: 'Get a webhook subscription',
        tags: ['Webhooks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Webhook subscription (signingSecret never returned here).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookSubscription' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      patch: {
        operationId: 'updateWebhook',
        summary: 'Update a webhook subscription',
        tags: ['Webhooks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  description: { type: 'string' },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated webhook subscription.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        operationId: 'deleteWebhook',
        summary: 'Delete a webhook subscription',
        tags: ['Webhooks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deletion confirmation.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/webhooks/{id}/rotate-secret': {
      post: {
        operationId: 'rotateWebhookSecret',
        summary: 'Rotate webhook signing secret',
        description:
          'Generates a new signing secret. The new `signingSecret` is returned in this response only.',
        tags: ['Webhooks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Updated subscription with new signingSecret.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookSubscription' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/webhooks/{id}/deliveries': {
      get: {
        operationId: 'listWebhookDeliveries',
        summary: 'List webhook deliveries',
        tags: ['Webhooks'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/startingAfterParam' },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
          },
        ],
        responses: {
          '200': { description: 'Paginated deliveries.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/webhooks/{id}/test': {
      post: {
        operationId: 'testWebhook',
        summary: 'Send a test ping to a webhook',
        description:
          'Emits a `ping` event that will be delivered to the endpoint within the next delivery cycle.',
        tags: ['Webhooks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Test event queued.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', enum: ['webhook_test'] },
                    queued: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/webhook-event-types': {
      get: {
        operationId: 'listWebhookEventTypes',
        summary: 'List available webhook event types',
        tags: ['Webhooks'],
        responses: {
          '200': {
            description: 'All supported event types.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ListMeta' },
                    {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/WebhookEventType' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/verification/status': {
      get: {
        operationId: 'getVerificationStatus',
        summary: "Get caller's verification status",
        description:
          "Returns the authenticated user's subject and active entitlements. Requires an OAuth token (the token sub is used as the identity).",
        tags: ['Verification'],
        responses: {
          '200': {
            description: 'Verification status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationStatus' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/verification/check': {
      post: {
        operationId: 'checkVerification',
        summary: 'Check verification for a subject and multiple products',
        tags: ['Verification'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subject', 'productIds'],
                properties: {
                  subject: {
                    type: 'object',
                    description:
                      'Subject selector: { subjectId } | { authUserId } | { discordUserId } | { externalAccount: { provider, providerUserId } }',
                  },
                  productIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Product IDs to check entitlements for.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification check results.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationCheck' },
              },
            },
          },
          '400': { description: 'Invalid request body.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'Get OpenAPI specification',
        description: 'Returns this OpenAPI 3.1.0 specification document.',
        tags: ['Meta'],
        security: [],
        responses: {
          '200': {
            description: 'OpenAPI specification.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
} as const;

export async function handleOpenApiRoutes(
  request: Request,
  subPath: string,
  _config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();

  if (subPath !== '/openapi.json') {
    return errorResponse('not_found', 'Route not found', 404, reqId);
  }

  if (request.method !== 'GET') {
    return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
  }

  return new Response(JSON.stringify(OPENAPI_SPEC, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': reqId,
      'Yucp-Version': '2025-03-01',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
