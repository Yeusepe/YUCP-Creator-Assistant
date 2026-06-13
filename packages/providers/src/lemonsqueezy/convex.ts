import type { ConvexProviderRuntimePorts } from '../convexRuntime';
import { createLemonSqueezyProviderModule, LEMONSQUEEZY_PURPOSES } from './module';

export default {
  id: 'lemonsqueezy' as const,
  createRuntime(ports: ConvexProviderRuntimePorts) {
    return createLemonSqueezyProviderModule({
      logger: ports.logger,
      async getEncryptedCredential(authUserId, ctx) {
        return await ports.loadPrimaryCredential(authUserId, 'lemonsqueezy', ctx);
      },
      async decryptCredential(encryptedCredential, ctx) {
        const decrypted = await ports.decryptStoredCredential(
          encryptedCredential,
          LEMONSQUEEZY_PURPOSES.credential,
          ctx
        );
        if (!decrypted) {
          throw new Error('Failed to decrypt stored Lemon Squeezy credential');
        }
        return decrypted;
      },
      async listCollaboratorConnections(ctx) {
        return await ports.loadCollaboratorConnections(ctx.authUserId, ctx);
      },
    });
  },
};
