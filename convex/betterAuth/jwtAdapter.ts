import type { GenericEndpointContext } from '@better-auth/core';
import type { Jwk, JwtOptions } from 'better-auth/plugins/jwt';

type JwtKeyRecord = Omit<Jwk, 'createdAt' | 'expiresAt'> & {
  createdAt: Date | number | string;
  expiresAt?: Date | number | string | null;
};

function normalizeDate(value: Date | number | string | null | undefined): Date | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

export function createJwtJwksAdapter(): NonNullable<JwtOptions['adapter']> {
  return {
    async getJwks(ctx: GenericEndpointContext): Promise<Jwk[]> {
      const keys = (await ctx.context.adapter.findMany({ model: 'jwks' })) as JwtKeyRecord[];
      return keys.map(
        (key): Jwk => ({
          id: key.id,
          publicKey: key.publicKey,
          privateKey: key.privateKey,
          alg: key.alg,
          crv: key.crv,
          createdAt: normalizeDate(key.createdAt) ?? new Date(0),
          expiresAt: normalizeDate(key.expiresAt) ?? undefined,
        })
      );
    },
  };
}
