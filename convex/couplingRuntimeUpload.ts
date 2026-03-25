import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/**
 * Mint a short-lived Convex Storage upload URL for the coupling runtime DLL.
 *
 * Preferred flow:
 *   1. Upload the DLL bytes to this URL.
 *   2. Activate the resulting storageId with couplingRuntime:publishUploadedRuntime.
 *
 * Manual dashboard flow:
 *   - Upload the DLL from Dashboard → File Storage.
 *   - Copy the returned storageId.
 *   - Run couplingRuntime:publishUploadedRuntime from Dashboard → Functions.
 */
export const generateRuntimeUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});
