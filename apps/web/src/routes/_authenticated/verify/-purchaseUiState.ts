import { ApiError } from '@/api/client';
import type { UserVerificationIntentRequirement } from '@/lib/account';
import { getApiErrorMessage } from '@/lib/apiErrors';

type PurchaseVerificationErrorInput = {
  errorCode: string | null;
  errorMessage: string | null;
  requirements: UserVerificationIntentRequirement[];
};

type PurchaseIntentLoadErrorState = {
  title: string;
  message: string;
  allowSignOut: boolean;
};

function readApiErrorCode(error: unknown) {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object') {
    return null;
  }

  const code = (error.body as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

export function shouldAutoCheckExistingEntitlement(
  requirements: Pick<UserVerificationIntentRequirement, 'kind'>[]
) {
  const hasEntitlement = requirements.some(
    (requirement) => requirement.kind === 'existing_entitlement'
  );
  const hasAlternateMethod = requirements.some(
    (requirement) =>
      requirement.kind === 'buyer_provider_link' || requirement.kind === 'manual_license'
  );
  return hasEntitlement && !hasAlternateMethod;
}

export function getVisiblePurchaseVerificationError({
  errorCode,
  errorMessage,
  requirements,
}: PurchaseVerificationErrorInput) {
  if (!errorMessage) {
    return null;
  }

  if (errorCode === 'entitlement_missing' && !shouldAutoCheckExistingEntitlement(requirements)) {
    return null;
  }

  return errorMessage;
}

export function getPurchaseIntentLoadErrorState(error: unknown): PurchaseIntentLoadErrorState {
  const code = readApiErrorCode(error);

  if (code === 'verification_intent_wrong_user') {
    return {
      title: 'Wrong YUCP account',
      message: getApiErrorMessage(
        error,
        'This verification link was created for a different YUCP account.'
      ),
      allowSignOut: true,
    };
  }

  if (code === 'verification_intent_missing') {
    return {
      title: 'Verification not found',
      message:
        'This verification link is invalid or has already expired. Return to Unity and restart the verification flow.',
      allowSignOut: false,
    };
  }

  return {
    title: 'Verification not found',
    message:
      'This verification link is invalid or has already expired. Return to Unity and restart the verification flow.',
    allowSignOut: false,
  };
}
