import type { BetterAuthPlugin } from 'better-auth';
import type { DBAdapter, Where } from 'better-auth/adapters';

export interface BetterAuthReservationRecord {
  createdAt: number;
  expiresAt: number;
  identifier: string;
  reservationId: string;
  updatedAt: number;
  value: string;
}

export interface BetterAuthReservationPort {
  find(reservationId: string): Promise<BetterAuthReservationRecord | null>;
  reserve(input: BetterAuthReservationRecord): Promise<boolean>;
}

type AdapterCreateInput = {
  data: Record<string, unknown>;
  forceAllowId?: boolean;
  model: string;
  select?: string[];
};

type AdapterFindOneInput = {
  model: string;
  select?: string[];
  where: Where[];
};

function toTimestamp(value: unknown, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new Error(`Better Auth verification ${field} must be a finite timestamp`);
  }
  return timestamp;
}

function parseReservationCreate(input: AdapterCreateInput): BetterAuthReservationRecord | null {
  if (input.model !== 'verification' || input.forceAllowId !== true) {
    return null;
  }

  const reservationId = input.data.id;
  const identifier = input.data.identifier;
  const value = input.data.value;
  if (
    typeof reservationId !== 'string' ||
    typeof identifier !== 'string' ||
    typeof value !== 'string'
  ) {
    return null;
  }

  return {
    reservationId,
    identifier,
    value,
    expiresAt: toTimestamp(input.data.expiresAt, 'expiresAt'),
    createdAt: toTimestamp(input.data.createdAt, 'createdAt'),
    updatedAt: toTimestamp(input.data.updatedAt, 'updatedAt'),
  };
}

function parseReservationLookup(input: AdapterFindOneInput): string | null {
  if (input.model !== 'verification' || input.where.length !== 1) {
    return null;
  }

  const clause = input.where[0];
  if (
    clause?.field !== 'id' ||
    (clause.operator !== undefined && clause.operator !== 'eq') ||
    typeof clause.value !== 'string'
  ) {
    return null;
  }

  return clause.value;
}

function toBetterAuthVerification(record: BetterAuthReservationRecord): Record<string, unknown> {
  return {
    id: record.reservationId,
    identifier: record.identifier,
    value: record.value,
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/**
 * Bridges Better Auth 1.7 atomic verification reservations to Convex.
 *
 * Better Auth permits plugins to replace the adapter during initialization.
 * The bridge stays removable when the upstream Convex adapter supports reservations.
 *
 * References:
 * https://better-auth.com/docs/beta/concepts/plugins
 * https://better-auth.com/docs/guides/create-a-db-adapter
 * https://better-auth.com/docs/guides/1-7-upgrade-guide
 */
export function betterAuthReservationBridge(port: BetterAuthReservationPort): BetterAuthPlugin {
  return {
    id: 'yucp-convex-verification-reservations',
    version: '1.0.0',
    init(context) {
      const adapter = context.adapter;
      const create: DBAdapter['create'] = async (input) => {
        const reservation = parseReservationCreate(input);
        if (!reservation) {
          return adapter.create(input);
        }

        if (!(await port.reserve(reservation))) {
          throw new Error('Better Auth verification reservation already exists');
        }
        return toBetterAuthVerification(reservation) as never;
      };
      const findOne: DBAdapter['findOne'] = async (input) => {
        const reservationId = parseReservationLookup(input);
        if (!reservationId) {
          return adapter.findOne(input);
        }

        const reservation = await port.find(reservationId);
        if (!reservation) {
          return adapter.findOne(input);
        }
        return toBetterAuthVerification(reservation) as never;
      };
      const bridgedAdapter: DBAdapter = {
        ...adapter,
        create,
        findOne,
      };
      return {
        context: {
          adapter: bridgedAdapter,
        },
      };
    },
  };
}
