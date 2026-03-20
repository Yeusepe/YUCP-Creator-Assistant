export interface InternalRpcSecretEnv {
  INTERNAL_RPC_SHARED_SECRET?: string;
  NODE_ENV?: string;
}

export const LOCAL_DEV_INTERNAL_RPC_SHARED_SECRET =
  'local-dev-internal-rpc-shared-secret-change-me-for-shared-dev';

export function getInternalRpcSharedSecret(env: InternalRpcSecretEnv = process.env): string {
  const configuredSecret = env.INTERNAL_RPC_SHARED_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('INTERNAL_RPC_SHARED_SECRET is not configured');
  }

  return LOCAL_DEV_INTERNAL_RPC_SHARED_SECRET;
}
