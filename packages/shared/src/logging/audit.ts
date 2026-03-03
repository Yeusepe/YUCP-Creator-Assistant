// Audit event system with typed event names
// Provides structured audit logging for compliance and security

import { type CorrelationId, generateCorrelationId } from './correlation';
import { redactForLogging } from './redaction';

/**
 * Audit event types based on plan requirements
 */
export type AuditEventType =
  // Verification events
  | 'verification.session.created'
  | 'verification.provider.completed'
  | 'verification.session.expired'
  | 'verification.session.failed'

  // Binding events
  | 'binding.activated'
  | 'binding.revoked'
  | 'binding.transfer.requested'
  | 'binding.transfer.completed'

  // Entitlement events
  | 'entitlement.granted'
  | 'entitlement.revoked'
  | 'entitlement.check'

  // Discord events
  | 'discord.role.sync.requested'
  | 'discord.role.sync.completed'
  | 'discord.role.sync.failed'
  | 'discord.guild.joined'
  | 'discord.guild.left'

  // Unity assertion events
  | 'unity.assertion.issued'
  | 'unity.assertion.validated'
  | 'unity.assertion.failed'

  // Security events
  | 'secret.accessed'
  | 'secret.modified'
  | 'secret.deleted'

  // Policy events
  | 'creator.policy.updated'
  | 'creator.policy.created'
  | 'creator.policy.deleted'

  // User events
  | 'user.login'
  | 'user.logout'
  | 'user.created'
  | 'user.deleted'
  | 'user.role.changed';

/**
 * Audit event severity levels
 */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Audit event actor (who performed the action)
 */
export interface AuditActor {
  type: 'user' | 'system' | 'api' | 'bot';
  id: string;
  displayName?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Audit event target (what was affected)
 */
export interface AuditTarget {
  type: string;
  id: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit event context
 */
export interface AuditContext {
  correlationId?: CorrelationId;
  tenantId?: string;
  environment?: string;
  requestId?: string;
  sessionId?: string;
}

/**
 * Complete audit event structure
 */
export interface AuditEvent {
  // Event identification
  id: string;
  type: AuditEventType;
  timestamp: string;
  severity: AuditSeverity;

  // Who and what
  actor: AuditActor;
  target?: AuditTarget;
  context: AuditContext;

  // Action details
  action: string;
  outcome: 'success' | 'failure' | 'partial';
  message?: string;

  // Additional data (automatically redacted)
  metadata?: Record<string, unknown>;
}

/**
 * Audit event data for creation (without auto-generated fields)
 */
export interface CreateAuditEvent {
  type: AuditEventType;
  severity?: AuditSeverity;
  actor: AuditActor;
  target?: AuditTarget;
  context?: AuditContext;
  action: string;
  outcome: 'success' | 'failure' | 'partial';
  message?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Map event types to default severity levels
 */
function getDefaultSeverity(eventType: AuditEventType): AuditSeverity {
  const severityMap: Partial<Record<AuditEventType, AuditSeverity>> = {
    'verification.session.created': 'info',
    'verification.provider.completed': 'info',
    'verification.session.expired': 'warning',
    'verification.session.failed': 'warning',
    'binding.activated': 'info',
    'binding.revoked': 'warning',
    'binding.transfer.completed': 'info',
    'entitlement.granted': 'info',
    'entitlement.revoked': 'warning',
    'entitlement.check': 'info',
    'discord.role.sync.completed': 'info',
    'discord.role.sync.failed': 'error',
    'discord.guild.joined': 'info',
    'discord.guild.left': 'warning',
    'unity.assertion.issued': 'info',
    'unity.assertion.validated': 'info',
    'unity.assertion.failed': 'error',
    'secret.accessed': 'warning',
    'secret.modified': 'warning',
    'secret.deleted': 'critical',
    'creator.policy.updated': 'warning',
    'creator.policy.deleted': 'critical',
    'user.login': 'info',
    'user.logout': 'info',
    'user.deleted': 'critical',
    'user.role.changed': 'warning',
  };

  return severityMap[eventType] || 'info';
}

/**
 * Create an audit event
 */
export function createAuditEvent(data: CreateAuditEvent): AuditEvent {
  return {
    id: generateCorrelationId(),
    type: data.type,
    timestamp: new Date().toISOString(),
    severity: data.severity || getDefaultSeverity(data.type),
    actor: data.actor,
    target: data.target,
    context: data.context || {},
    action: data.action,
    outcome: data.outcome,
    message: data.message,
    metadata: data.metadata ? redactForLogging(data.metadata) : undefined,
  };
}

/**
 * Audit writer interface
 * Implement this to write audit events to your preferred storage
 */
export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
  writeBatch(events: AuditEvent[]): Promise<void>;
}

/**
 * Console audit writer (for development/testing)
 */
export class ConsoleAuditWriter implements AuditWriter {
  private readonly prettyPrint: boolean;

  constructor(prettyPrint = false) {
    this.prettyPrint = prettyPrint;
  }

  async write(event: AuditEvent): Promise<void> {
    this.output([event]);
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    this.output(events);
  }

  private output(events: AuditEvent[]): void {
    if (this.prettyPrint) {
      for (const event of events) {
        console.log(`[AUDIT:${event.severity.toUpperCase()}] ${event.timestamp} - ${event.type}`);
        console.log(`  Actor: ${event.actor.type}:${event.actor.id}`);
        if (event.target) {
          console.log(`  Target: ${event.target.type}:${event.target.id}`);
        }
        console.log(`  Action: ${event.action} (${event.outcome})`);
        if (event.message) {
          console.log(`  Message: ${event.message}`);
        }
        console.log('---');
      }
    } else {
      const output = events.map((e) => JSON.stringify(e)).join('\n');
      console.log(output);
    }
  }
}

/**
 * Create an audit event helper for common scenarios
 */
export function createAuditHelper(writer: AuditWriter) {
  return {
    /**
     * Log an audit event
     */
    log: async (data: CreateAuditEvent): Promise<AuditEvent> => {
      const event = createAuditEvent(data);
      await writer.write(event);
      return event;
    },

    /**
     * Log verification events
     */
    verification: {
      sessionCreated: (actor: AuditActor, context: AuditContext, target?: AuditTarget) =>
        writer.write(
          createAuditEvent({
            type: 'verification.session.created',
            actor,
            target,
            context,
            action: 'verification_session_created',
            outcome: 'success',
            message: 'Verification session created',
          })
        ),

      providerCompleted: (
        actor: AuditActor,
        context: AuditContext,
        provider: string,
        target?: AuditTarget
      ) =>
        writer.write(
          createAuditEvent({
            type: 'verification.provider.completed',
            actor,
            target,
            context,
            action: 'verification_provider_completed',
            outcome: 'success',
            message: `Verification provider ${provider} completed`,
            metadata: { provider },
          })
        ),
    },

    /**
     * Log binding events
     */
    binding: {
      activated: (actor: AuditActor, context: AuditContext, target: AuditTarget) =>
        writer.write(
          createAuditEvent({
            type: 'binding.activated',
            actor,
            target,
            context,
            action: 'binding_activated',
            outcome: 'success',
            message: 'Binding activated',
          })
        ),

      revoked: (actor: AuditActor, context: AuditContext, target: AuditTarget, reason?: string) =>
        writer.write(
          createAuditEvent({
            type: 'binding.revoked',
            actor,
            target,
            context,
            action: 'binding_revoked',
            outcome: 'success',
            message: reason || 'Binding revoked',
            metadata: { reason },
          })
        ),
    },

    /**
     * Log entitlement events
     */
    entitlement: {
      granted: (
        actor: AuditActor,
        context: AuditContext,
        target: AuditTarget,
        entitlement: string
      ) =>
        writer.write(
          createAuditEvent({
            type: 'entitlement.granted',
            actor,
            target,
            context,
            action: 'entitlement_granted',
            outcome: 'success',
            message: `Entitlement ${entitlement} granted`,
            metadata: { entitlement },
          })
        ),

      revoked: (
        actor: AuditActor,
        context: AuditContext,
        target: AuditTarget,
        entitlement: string,
        reason?: string
      ) =>
        writer.write(
          createAuditEvent({
            type: 'entitlement.revoked',
            actor,
            target,
            context,
            action: 'entitlement_revoked',
            outcome: 'success',
            message: reason || `Entitlement ${entitlement} revoked`,
            metadata: { entitlement, reason },
          })
        ),
    },

    /**
     * Log Discord events
     */
    discord: {
      roleSyncRequested: (actor: AuditActor, context: AuditContext, guildId: string) =>
        writer.write(
          createAuditEvent({
            type: 'discord.role.sync.requested',
            actor,
            context,
            action: 'discord_role_sync_requested',
            outcome: 'success',
            message: 'Discord role sync requested',
            metadata: { guildId },
          })
        ),

      roleSyncCompleted: (
        actor: AuditActor,
        context: AuditContext,
        guildId: string,
        rolesCount: number
      ) =>
        writer.write(
          createAuditEvent({
            type: 'discord.role.sync.completed',
            actor,
            context,
            action: 'discord_role_sync_completed',
            outcome: 'success',
            message: `Discord role sync completed: ${rolesCount} roles`,
            metadata: { guildId, rolesCount },
          })
        ),
    },

    /**
     * Log Unity assertion events
     */
    unity: {
      assertionIssued: (
        actor: AuditActor,
        context: AuditContext,
        assertionId: string,
        target: AuditTarget
      ) =>
        writer.write(
          createAuditEvent({
            type: 'unity.assertion.issued',
            actor,
            target,
            context,
            action: 'unity_assertion_issued',
            outcome: 'success',
            message: `Unity assertion ${assertionId} issued`,
            metadata: { assertionId },
          })
        ),
    },

    /**
     * Log security events
     */
    security: {
      secretAccessed: (actor: AuditActor, context: AuditContext, secretName: string) =>
        writer.write(
          createAuditEvent({
            type: 'secret.accessed',
            actor,
            context,
            action: 'secret_accessed',
            outcome: 'success',
            message: `Secret ${secretName} accessed`,
            metadata: { secretName, _warning: 'Secret access should be limited' },
          })
        ),
    },

    /**
     * Log policy events
     */
    policy: {
      updated: (
        actor: AuditActor,
        context: AuditContext,
        target: AuditTarget,
        changes: Record<string, unknown>
      ) =>
        writer.write(
          createAuditEvent({
            type: 'creator.policy.updated',
            actor,
            target,
            context,
            action: 'policy_updated',
            outcome: 'success',
            message: 'Creator policy updated',
            metadata: { changes },
          })
        ),
    },
  };
}
