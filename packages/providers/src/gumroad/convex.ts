import type { ConvexProviderRuntimePorts } from '../convexRuntime';
import { createGumroadProviderModule, GUMROAD_PURPOSES } from './module';

export default {
  id: 'gumroad' as const,
  createRuntime(ports: ConvexProviderRuntimePorts) {
    return createGumroadProviderModule({
      logger: ports.logger,
      async getEncryptedCredential(ctx) {
        return await ports.loadPrimaryCredential(ctx.authUserId, 'gumroad', ctx);
      },
      async decryptCredential(encryptedCredential, ctx) {
        const decrypted = await ports.decryptStoredCredential(
          encryptedCredential,
          GUMROAD_PURPOSES.credential,
          ctx
        );
        if (!decrypted) {
          throw new Error('Failed to decrypt stored Gumroad credential');
        }
        return decrypted;
      },
    });
  },
};
