/**
 * Verification Module Index
 *
 * Exports verification session management functionality.
 */

export {
  type CallbackResult,
  type CompleteVerificationInput,
  type CompleteVerificationResult,
  type CreateSessionInput,
  type CreateSessionResult,
  computeCodeChallenge,
  createVerificationRoutes,
  createVerificationSessionManager,
  generateCodeVerifier,
  generateState,
  getVerificationConfig,
  hashVerifier,
  mountVerificationRouteHandlers,
  mountVerificationRoutes,
  SESSION_EXPIRY_MS,
  type VerificationConfig,
  type VerificationRouteHandlers,
  type VerificationSessionManager,
} from './sessionManager';
