import type { ConvexProviderRuntimePorts } from '../convexRuntime';
import { createJinxxyProviderModule, JINXXY_PURPOSES } from './module';

export default {
  id: 'jinxxy' as const,
  createRuntime(ports: ConvexProviderRuntimePorts) {
    return createJinxxyProviderModule({
      logger: ports.logger,
      async getEncryptedCredential(authUserId, ctx) {
        return await ports.loadPrimaryCredential(authUserId, 'jinxxy', ctx);
      },
      async decryptCredential(encryptedCredential, ctx) {
        const decrypted = await ports.decryptStoredCredential(
          encryptedCredential,
          JINXXY_PURPOSES.credential,
          ctx
        );
        if (!decrypted) {
          throw new Error('Failed to decrypt stored Jinxxy credential');
        }
        return decrypted;
      },
      async listCollaboratorConnections(ctx) {
        return await ports.loadCollaboratorConnections(ctx.authUserId, ctx);
      },
    });
  },
};
