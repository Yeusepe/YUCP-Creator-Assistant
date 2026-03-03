/**
 * Verification Module Index
 *
 * Exports verification session management functionality.
 */

export {
  createVerificationSessionManager,
  createVerificationRoutes,
  mountVerificationRoutes,
  type VerificationConfig,
  type VerificationRouteHandlers,
  type VerificationSessionManager,
  type CreateSessionInput,
  type CreateSessionResult,
  type CallbackResult,
  type CompleteVerificationInput,
  type CompleteVerificationResult,
  SESSION_EXPIRY_MS,
  generateState,
  generateCodeVerifier,
  computeCodeChallenge,
  hashVerifier,
  getVerificationConfig,
} from './sessionManager';
