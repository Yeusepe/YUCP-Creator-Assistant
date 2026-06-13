import type { ConvexProviderRuntimePorts } from '../convexRuntime';
import { createPayhipProviderModule, PAYHIP_PURPOSES } from './module';

export default {
  id: 'payhip' as const,
  createRuntime(ports: ConvexProviderRuntimePorts) {
    return createPayhipProviderModule({
      logger: ports.logger,
      async listProducts() {
        return [];
      },
      async upsertProductName() {},
      async listProductSecretKeys(authUserId, ctx) {
        return await ports.loadProductSecretKeys(authUserId, 'payhip', ctx);
      },
      async decryptProductSecretKey(encryptedSecretKey, ctx) {
        const decrypted = await ports.decryptStoredCredential(
          encryptedSecretKey,
          PAYHIP_PURPOSES.productSecret,
          ctx
        );
        if (!decrypted) {
          throw new Error('Failed to decrypt stored Payhip product secret');
        }
        return decrypted;
      },
    });
  },
};
