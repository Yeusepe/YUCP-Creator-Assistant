import { createFileRoute, useNavigate } from '@tanstack/react-router';
import confetti from 'canvas-confetti';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { copyToClipboard } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Provider UI configuration
// ---------------------------------------------------------------------------

interface ProviderUIConfig {
  label: string;
  placeholder: string;
  apiFormHeading: string;
  apiFormInstructions: string;
  consentDescription: string;
  errorEmpty: string;
  supportsAccountLinking: boolean;
}

const PROVIDER_UI: Record<string, ProviderUIConfig> = {
  jinxxy: {
    label: 'Jinxxy\u2122',
    placeholder: 'jinxxy_...',
    apiFormHeading: 'Enter your Jinxxy\u2122 API key',
    apiFormInstructions:
      'In Jinxxy\u2122, go to <strong style="color:white;">Settings \u2192 API Keys</strong> and click <strong style="color:white;">New API Key</strong>. Enable scopes: <code style="font-size:12px;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;">products_read</code> <code style="font-size:12px;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;">orders_read</code> <code style="font-size:12px;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;">licenses_read</code>. Then paste it below.',
    consentDescription:
      'Your Jinxxy\u2122 API key is used to verify licenses sold through your store',
    errorEmpty: 'Please enter your Jinxxy\u2122 API key.',
    supportsAccountLinking: true,
  },
  lemonsqueezy: {
    label: 'Lemon Squeezy',
    placeholder: 'eyJ0...',
    apiFormHeading: 'Enter your Lemon Squeezy API key',
    apiFormInstructions:
      'In Lemon Squeezy, go to <strong style="color:white;">Settings \u2192 API</strong> and click <strong style="color:white;">Create new API key</strong>. Then paste it below.',
    consentDescription:
      'Your Lemon Squeezy API key is used to verify licenses sold through your store',
    errorEmpty: 'Please enter your Lemon Squeezy API key.',
    supportsAccountLinking: false,
  },
};

const DEFAULT_PROVIDER_UI: ProviderUIConfig = {
  label: '',
  placeholder: 'Paste your API key...',
  apiFormHeading: 'Enter your API key',
  apiFormInstructions: 'Go to your provider dashboard and create an API key, then paste it below.',
  consentDescription: 'Your API key is used to verify licenses sold through your store',
  errorEmpty: 'Please enter your API key.',
  supportsAccountLinking: false,
};

function getProviderUI(providerKey: string | undefined): ProviderUIConfig {
  if (providerKey && PROVIDER_UI[providerKey]) return PROVIDER_UI[providerKey];
  return {
    ...DEFAULT_PROVIDER_UI,
    label: providerKey ?? '',
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Stage =
  | 'stage-loading'
  | 'stage-consent'
  | 'stage-returning'
  | 'stage-type'
  | 'stage-account-wizard'
  | 'stage-api-form'
  | 'stage-success'
  | 'stage-error';

interface InviteData {
  ownerDisplayName: string;
  providerKey: string;
  expiresAt: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function CollabInvitePage() {
  const navigate = useNavigate();
  const { auth, t: inviteTokenFromSearch } = Route.useSearch();

  // ---- State ----
  const [activeStage, setActiveStage] = useState<Stage>('stage-loading');
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [selectedType, setSelectedType] = useState<'account' | 'api' | null>(null);
  const [_webhookConfig, setWebhookConfig] = useState<{
    callbackUrl: string;
  } | null>(null);
  const [wizStep, setWizStep] = useState(1);
  const [testWebhookReceived, setTestWebhookReceived] = useState(false);
  const [testWebhookPollingStarted, setTestWebhookPollingStarted] = useState(false);
  const [testWebhookTimedOut, setTestWebhookTimedOut] = useState(false);
  const [errorTitle, setErrorTitle] = useState('Something went wrong');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [backToDashboardUrl, setBackToDashboardUrl] = useState<string | null>(null);
  const [signingSecret, setSigningSecret] = useState('');
  const [accountApiKey, setAccountApiKey] = useState('');
  const [apiFormKey, setApiFormKey] = useState('');
  const [accountError, setAccountError] = useState('');
  const [apiFormError, setApiFormError] = useState('');
  const [btnTypeDisabled, setBtnTypeDisabled] = useState(true);
  const [wizTestNextDisabled, setWizTestNextDisabled] = useState(true);
  const [wizTestNextText, setWizTestNextText] = useState('Waiting...');
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [apiSubmitting, setApiSubmitting] = useState(false);
  const [webhookCallbackUrl, setWebhookCallbackUrl] = useState('Loading...');
  const [signingSecretError, setSigningSecretError] = useState('');
  const [copyBtnColor, setCopyBtnColor] = useState('');
  const [copyBtnText, setCopyBtnText] = useState('Copy');
  const [pageVisible, setPageVisible] = useState(false);

  const testWebhookIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inviteDataRef = useRef<InviteData | null>(null);
  const normalizedHashTokenRef = useRef<string | null>(null);

  // Keep ref in sync for use in async callbacks
  useEffect(() => {
    inviteDataRef.current = inviteData;
  }, [inviteData]);

  // ---- Helpers ----

  const goToStage = useCallback((stage: Stage) => {
    setActiveStage(stage);
  }, []);

  const showError = useCallback(
    (title: string, message: string) => {
      setErrorTitle(title);
      setErrorMessage(message);
      goToStage('stage-error');
    },
    [goToStage]
  );

  const handleCopyText = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopyBtnText('Copied!');
      setCopyBtnColor('#43b581');
      setTimeout(() => {
        setCopyBtnText('Copy');
        setCopyBtnColor('');
      }, 2000);
    }
  }, []);

  const selectType = useCallback((type: 'account' | 'api') => {
    setSelectedType(type);
    setBtnTypeDisabled(false);
  }, []);

  // ---- Webhook secret save ----

  const saveWebhookSecret = useCallback(async (secret: string) => {
    if (!secret || secret.length < 16) {
      throw new Error('Create a signing secret with at least 16 characters.');
    }
    const res = await fetch('/api/collab/session/webhook-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webhookSecret: secret }),
    });
    if (!res.ok) {
      throw new Error('Could not save your signing secret.');
    }
  }, []);

  // ---- Wizard navigation ----

  const _wizNext = useCallback(async () => {
    try {
      setWizStep((prev) => {
        if (prev >= 5) return prev;
        return prev; // actual advance happens in the async path
      });
      // We need the current step value synchronously. Use a ref trick:
    } catch {
      // handled below
    }
  }, []);

  // We use a separate effect-driven approach, but the original code used imperative
  // advancement. Let's keep it closer to the original with a ref for wizStep.
  const wizStepRef = useRef(wizStep);
  useEffect(() => {
    wizStepRef.current = wizStep;
  }, [wizStep]);

  const advanceWizard = useCallback(async () => {
    const currentStep = wizStepRef.current;
    if (currentStep >= 5) return;
    if (currentStep === 2) {
      await saveWebhookSecret(signingSecret);
    }
    const nextStep = currentStep + 1;
    setWizStep(nextStep);
    if (nextStep === 4 && !testWebhookPollingStarted) {
      setTestWebhookPollingStarted(true);
    }
  }, [saveWebhookSecret, signingSecret, testWebhookPollingStarted]);

  const handleWizNext = useCallback(() => {
    // Validate signing secret inline on step 2 before attempting server save
    if (wizStepRef.current === 2) {
      if (!signingSecret || signingSecret.length < 16) {
        setSigningSecretError('Create a signing secret with at least 16 characters.');
        return;
      }
      setSigningSecretError('');
    }
    advanceWizard().catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not continue right now.';
      // Surface save failures inline rather than navigating away from the wizard
      setSigningSecretError(message);
    });
  }, [advanceWizard, signingSecret]);

  const handleWizBack = useCallback(() => {
    setWizStep((prev) => (prev <= 1 ? prev : prev - 1));
    setSigningSecretError('');
  }, []);

  // ---- Discord auth ----

  const beginDiscordAuth = useCallback(() => {
    window.location.href = '/api/collab/auth/begin';
  }, []);

  // ---- Reuse key ----

  const setReuseKey = useCallback(
    (_reuse: boolean) => {
      goToStage('stage-type');
    },
    [goToStage]
  );

  // ---- Continue from type ----

  const startAccountLinking = useCallback(async () => {
    setWizStep(1);
    setTestWebhookReceived(false);
    setTestWebhookPollingStarted(false);
    setTestWebhookTimedOut(false);
    setWizTestNextDisabled(true);
    setWizTestNextText('Waiting...');
    if (testWebhookIntervalRef.current) {
      clearInterval(testWebhookIntervalRef.current);
      testWebhookIntervalRef.current = null;
    }

    goToStage('stage-account-wizard');

    try {
      const res = await fetch('/api/collab/session/webhook-config', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch webhook config');
      const config = await res.json();
      setWebhookConfig(config);
      setWebhookCallbackUrl(config.callbackUrl);
    } catch {
      setWebhookCallbackUrl('Error loading config');
    }
  }, [goToStage]);

  const startApiLinking = useCallback(() => {
    goToStage('stage-api-form');
  }, [goToStage]);

  const continueFromType = useCallback(() => {
    if (!selectedType) return;
    if (selectedType === 'account') {
      startAccountLinking();
    } else {
      startApiLinking();
    }
  }, [selectedType, startAccountLinking, startApiLinking]);

  // ---- Test webhook polling ----

  useEffect(() => {
    if (!testWebhookPollingStarted || wizStep !== 4) return;

    let elapsed = 0;
    let received = false;

    const interval = setInterval(async () => {
      elapsed += 2500;
      try {
        const res = await fetch('/api/collab/session/test-webhook', {
          credentials: 'include',
        });
        const data = await res.json();
        if (data.received) {
          clearInterval(interval);
          received = true;
          setTestWebhookReceived(true);
          setWizTestNextDisabled(false);
          setWizTestNextText('Next');
        }
      } catch {
        /* ignore */
      }

      if (elapsed >= 60000 && !received) {
        clearInterval(interval);
        setTestWebhookTimedOut(true);
        setWizTestNextDisabled(false);
        setWizTestNextText('Continue anyway');
      }
    }, 2500);

    testWebhookIntervalRef.current = interval;

    return () => {
      clearInterval(interval);
    };
  }, [testWebhookPollingStarted, wizStep]);

  // ---- Submit account linking ----

  const submitAccountLinking = useCallback(async () => {
    setAccountError('');
    const data = inviteDataRef.current;
    if (!accountApiKey.trim()) {
      setAccountError(getProviderUI(data?.providerKey).errorEmpty);
      return;
    }

    setAccountSubmitting(true);

    try {
      const res = await fetch('/api/collab/session/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          linkType: 'account',
          apiKey: accountApiKey.trim(),
        }),
      });
      await res.json();

      if (!res.ok) {
        setAccountError('Could not connect this account right now. Check the key and try again.');
        setAccountSubmitting(false);
        return;
      }

      // Success
      if (testWebhookIntervalRef.current) clearInterval(testWebhookIntervalRef.current);
      setSuccessMessage(
        `Your customers can now verify their purchases in ${data?.ownerDisplayName}'s Discord server.`
      );
      goToStage('stage-success');
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    } catch {
      setAccountError('Network error. Please try again.');
      setAccountSubmitting(false);
    }
  }, [accountApiKey, goToStage]);

  // ---- Submit API linking ----

  const submitApiLinking = useCallback(async () => {
    setApiFormError('');
    const data = inviteDataRef.current;
    if (!apiFormKey.trim()) {
      setApiFormError(getProviderUI(data?.providerKey).errorEmpty);
      return;
    }

    setApiSubmitting(true);

    try {
      const res = await fetch('/api/collab/session/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          linkType: 'api',
          apiKey: apiFormKey.trim(),
        }),
      });
      await res.json();

      if (!res.ok) {
        setApiFormError('Could not connect this account right now. Check the key and try again.');
        setApiSubmitting(false);
        return;
      }

      // Success
      if (testWebhookIntervalRef.current) clearInterval(testWebhookIntervalRef.current);
      setSuccessMessage(
        `Your customers can now verify their purchases in ${data?.ownerDisplayName}'s Discord server.`
      );
      goToStage('stage-success');
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    } catch {
      setApiFormError('Network error. Please try again.');
      setApiSubmitting(false);
    }
  }, [apiFormKey, goToStage]);

  // ---- Exchange invite token ----

  const exchangeInviteToken = useCallback(
    async (rawToken: string): Promise<InviteData> => {
      const res = await fetch('/api/collab/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: rawToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errorMap: Record<string, [string, string]> = {
          not_found: ['Invite Not Found', 'This invite link is invalid or has already been used.'],
          revoked: ['Invite Revoked', 'This invite has been revoked by the server owner.'],
          already_used: [
            'Already Used',
            'This invite has already been accepted. Each invite can only be used once.',
          ],
          expired: [
            'Invite Expired',
            'This invite link has expired. Please ask the server owner to send a new one.',
          ],
        };
        const [title, msg] = errorMap[data.error] || [
          'Error',
          'Something went wrong with this invite link.',
        ];
        throw new Error(JSON.stringify({ title, msg }));
      }
      navigate({
        to: '/collab-invite',
        search: {
          auth,
          t: undefined,
        },
        hash: '',
        replace: true,
      });
      return data;
    },
    [auth, navigate]
  );

  // ---- Init ----

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const legacyToken = hash.get('t');
    if (legacyToken && legacyToken !== normalizedHashTokenRef.current) {
      normalizedHashTokenRef.current = legacyToken;
      navigate({
        to: '/collab-invite',
        search: {
          auth,
          t: legacyToken,
        },
        hash: '',
        replace: true,
      });
      return;
    }

    // Back to dashboard button
    const urlParams = new URLSearchParams(window.location.search);
    const tId = urlParams.get('tenant_id') || urlParams.get('tenantId') || '';
    const gId = urlParams.get('guild_id') || urlParams.get('guildId') || '';
    if (tId && tId !== '__TENANT_ID__') {
      const dashboardUrl = new URL('/dashboard', window.location.origin);
      dashboardUrl.searchParams.set('tenant_id', tId);
      if (gId && gId !== '__GUILD_ID__') dashboardUrl.searchParams.set('guild_id', gId);
      setBackToDashboardUrl(dashboardUrl.toString());
    }

    // Fade in
    requestAnimationFrame(() => requestAnimationFrame(() => setPageVisible(true)));

    // Main init
    const init = async () => {
      if (auth === 'error') {
        showError(
          'Authentication Failed',
          'Could not verify your Discord\u00ae identity. Please try the link again or contact the server owner.'
        );
        return;
      }

      let invite: InviteData;

      try {
        if (inviteTokenFromSearch) {
          invite = await exchangeInviteToken(inviteTokenFromSearch);
        } else {
          const res = await fetch('/api/collab/session/invite', {
            credentials: 'include',
          });
          const data = await res.json();
          if (!res.ok) {
            const errorMap: Record<string, [string, string]> = {
              not_found: [
                'Invalid Link',
                'This invite session is missing or has expired. Please ask the server owner to resend the invite.',
              ],
              revoked: ['Invite Revoked', 'This invite has been revoked by the server owner.'],
              already_used: [
                'Already Used',
                'This invite has already been accepted. Each invite can only be used once.',
              ],
              expired: [
                'Invite Expired',
                'This invite link has expired. Please ask the server owner to send a new one.',
              ],
            };
            const [title, msg] = errorMap[data.error] || [
              'Error',
              'Something went wrong with this invite link.',
            ];
            showError(title, msg);
            return;
          }
          invite = data;
        }

        setInviteData(invite);
        inviteDataRef.current = invite;
      } catch (err) {
        try {
          const parsed = JSON.parse(err instanceof Error ? err.message : '');
          showError(parsed.title, parsed.msg);
        } catch {
          showError(
            'Connection Error',
            'Could not load this invite. Please check your internet connection and try again.'
          );
        }
        return;
      }

      if (auth === 'done') {
        try {
          const statusRes = await fetch('/api/collab/session/discord-status', {
            credentials: 'include',
          });
          const status = await statusRes.json();

          if (!status.authenticated) {
            showError(
              'Authentication Failed',
              'Your Discord\u00ae identity could not be confirmed. Please try the link again.'
            );
            return;
          }

          goToStage('stage-type');
        } catch {
          showError(
            'Connection Error',
            'Could not verify your Discord\u00ae identity. Please check your connection and try again.'
          );
        }
        return;
      }

      goToStage('stage-consent');
    };

    init();
  }, [auth, exchangeInviteToken, goToStage, inviteTokenFromSearch, navigate, showError]);

  // ---- Derived values ----

  const providerUI = getProviderUI(inviteData?.providerKey);

  const consentTitle = inviteData
    ? `${inviteData.ownerDisplayName} wants to share license verification with your ${providerUI.label} store`
    : '';

  const consentExpiry = inviteData
    ? `Invite expires ${new Date(inviteData.expiresAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`
    : '';

  // Wizard progress dots
  const wizDots = [1, 2, 3, 4, 5].map((step) => {
    if (step < wizStep) return { background: '#43b581', width: '8px' };
    if (step === wizStep) return { background: '#5865F2', width: '32px' };
    return { background: 'rgba(255,255,255,0.15)', width: '8px' };
  });

  // ---- Render ----

  return (
    <div className="collab-invite-page flex flex-col items-center justify-center min-h-screen p-4 py-8">
      {/* Cloud background rendered independently so it doesn't fade with page-content */}
      <CloudBackground variant="default" />

      <div id="page-content" className={pageVisible ? 'is-visible' : ''}>
        {/* Back to dashboard button */}
        {backToDashboardUrl && (
          <a
            href={backToDashboardUrl}
            className="fixed top-6 left-6 z-[100] inline-flex items-center gap-2 px-4 py-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-white/10 transition-all font-bold text-sm shadow-xl"
            style={{ textDecoration: 'none' }}
          >
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to Dashboard
          </a>
        )}

        <div className="w-full max-w-lg relative z-10">
          {/* Logo */}
          <div className="text-center mb-8">
            <img
              src="/Icons/MainLogo.png"
              alt="Creator Assistant logo"
              className="h-8 sm:h-10 max-w-full w-auto object-contain object-center flex-shrink-0 mx-auto"
            />
          </div>

          {/* Stage 0: Loading */}
          {activeStage === 'stage-loading' && (
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="spinner" />
              </div>
              <p style={{ color: 'var(--text-secondary)' }}>Loading invite...</p>
            </div>
          )}

          {/* Stage 1: Consent */}
          {activeStage === 'stage-consent' && (
            <div className="ci-card fade-in">
              <h1 className="text-2xl font-heading font-bold mb-2 text-center">{consentTitle}</h1>
              <p className="text-center mb-6" style={{ color: 'var(--text-secondary)' }}>
                {consentExpiry}
              </p>

              <div className="ci-access-list">
                <h3>What this grants access to:</h3>
                <ul>
                  <li>
                    <img src="/Icons/Checkmark.png" width="16" height="16" alt="" />
                    <span>{providerUI.consentDescription}</span>
                  </li>
                  <li>
                    <img src="/Icons/Checkmark.png" width="16" height="16" alt="" />
                    <span>
                      The Assistant will only check if a license key is valid. No personal data is
                      stored beyond your Discord&reg; ID
                    </span>
                  </li>
                  <li>
                    <img src="/Icons/Checkmark.png" width="16" height="16" alt="" />
                    <span>You can revoke access at any time by contacting the server owner</span>
                  </li>
                </ul>
              </div>

              <button type="button" className="btn-discord w-full" onClick={beginDiscordAuth}>
                <img src="/Icons/Discord.png" width="20" height="20" alt="" />
                Continue with Discord&reg;
              </button>
            </div>
          )}

          {/* Stage 2: Returning user */}
          {activeStage === 'stage-returning' && (
            <div className="ci-card fade-in" style={{ textAlign: 'center' }}>
              <h2 className="text-xl font-heading font-bold mb-2">Welcome back!</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                We noticed you've connected with Creator Assistant before.
                <br />
                Would you like to reuse your previous API key?
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => setReuseKey(true)}
                >
                  Reuse my previous API key
                </button>
                <button
                  type="button"
                  className="btn-secondary w-full"
                  onClick={() => setReuseKey(false)}
                >
                  Enter a new key
                </button>
              </div>
            </div>
          )}

          {/* Stage 3: Type selection */}
          {activeStage === 'stage-type' && (
            <div className="ci-card fade-in">
              <h2 className="text-xl font-heading font-bold mb-1 text-center">
                Choose how to connect
              </h2>
              <p className="text-center mb-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {inviteData ? `Connecting your ${providerUI.label} store` : ''}
              </p>
              <p className="text-center mb-6" style={{ color: 'var(--text-secondary)' }}>
                Select your preferred integration method.
              </p>

              <div className="space-y-3 mb-6">
                {providerUI.supportsAccountLinking && (
                  <button
                    type="button"
                    className={`card-option${selectedType === 'account' ? ' selected' : ''}`}
                    onClick={() => selectType('account')}
                  >
                    <div className="flex items-start gap-3">
                      <img
                        src="/Icons/Link.png"
                        width="20"
                        height="20"
                        alt=""
                        style={{
                          marginTop: '2px',
                          flexShrink: 0,
                          opacity: 0.85,
                        }}
                      />
                      <div>
                        <h3 className="font-heading font-semibold">
                          Account Linking{' '}
                          <span
                            className="text-xs ml-1 px-2 py-0.5 rounded-full"
                            style={{
                              background: '#5865F2',
                              color: '#ffffff',
                            }}
                          >
                            Recommended
                          </span>
                        </h3>
                        <p
                          className="text-sm mt-1"
                          style={{
                            color: 'var(--text-secondary)',
                          }}
                        >
                          API key + webhook. Automatic role assignment when purchases are made, plus
                          manual verification.
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                <button
                  type="button"
                  className={`card-option${selectedType === 'api' ? ' selected' : ''}`}
                  onClick={() => selectType('api')}
                >
                  <div className="flex items-start gap-3">
                    <img
                      src="/Icons/Key.png"
                      width="20"
                      height="20"
                      alt=""
                      style={{
                        marginTop: '2px',
                        flexShrink: 0,
                        opacity: 0.85,
                      }}
                    />
                    <div>
                      <h3 className="font-heading font-semibold">API Linking</h3>
                      <p
                        className="text-sm mt-1"
                        style={{
                          color: 'var(--text-secondary)',
                        }}
                      >
                        API key only. Users must run /verify manually. No automatic role assignment.
                      </p>
                    </div>
                  </div>
                </button>
              </div>

              <button
                type="button"
                className="btn-primary w-full"
                disabled={btnTypeDisabled}
                onClick={continueFromType}
              >
                Continue
              </button>
            </div>
          )}

          {/* Stage 4a: Account Linking Wizard */}
          {activeStage === 'stage-account-wizard' && (
            <div className="ci-card fade-in">
              {/* Header: title + step counter */}
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <img
                    src="/Icons/Link.png"
                    width="16"
                    height="16"
                    alt=""
                    style={{ opacity: 0.7 }}
                  />
                  <span
                    className="text-sm font-semibold"
                    style={{ color: 'rgba(255,255,255,0.5)' }}
                  >
                    Account Linking
                  </span>
                </div>
                <span className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Step {wizStep} of 5
                </span>
              </div>

              {/* Progress bar */}
              <div className="flex gap-1.5 mb-6">
                {wizDots.map((dot, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: static decorative dots
                    key={i}
                    className="rounded-full transition-all duration-300"
                    style={{
                      height: '4px',
                      width: dot.width,
                      background: dot.background,
                    }}
                  />
                ))}
              </div>

              {/* Step 1: Open Jinxxy Webhooks */}
              {wizStep === 1 && (
                <div>
                  {/* Visual mockup: Jinxxy sidebar */}
                  <div
                    className="rounded-xl overflow-hidden mb-5"
                    style={{
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                      display: 'flex',
                      height: '120px',
                    }}
                  >
                    <div
                      style={{
                        width: '130px',
                        background: '#1a1a1a',
                        borderRight: '1px solid #2a2a2a',
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '5px',
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          height: '10px',
                          width: '55px',
                          background: '#333',
                          borderRadius: '3px',
                          marginBottom: '8px',
                        }}
                      />
                      <div
                        style={{
                          height: '8px',
                          width: '90%',
                          background: '#2a2a2a',
                          borderRadius: '2px',
                        }}
                      />
                      <div
                        style={{
                          height: '8px',
                          width: '70%',
                          background: '#2a2a2a',
                          borderRadius: '2px',
                        }}
                      />
                      <div
                        style={{
                          height: '6px',
                          width: '45%',
                          background: '#444',
                          borderRadius: '2px',
                          marginTop: '6px',
                          marginBottom: '2px',
                        }}
                      />
                      <div
                        style={{
                          height: '8px',
                          width: '80%',
                          background: '#2a2a2a',
                          borderRadius: '2px',
                        }}
                      />
                      {/* Highlighted Webhooks */}
                      <div
                        style={{
                          padding: '5px 7px',
                          background: 'rgba(88,101,242,0.15)',
                          border: '1px solid #5865F2',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <div
                          style={{
                            width: '10px',
                            height: '10px',
                            background: '#5865F2',
                            borderRadius: '2px',
                            flexShrink: 0,
                          }}
                        />
                        <div
                          style={{
                            height: '7px',
                            width: '42px',
                            background: '#8b9cf4',
                            borderRadius: '2px',
                            opacity: 0.7,
                          }}
                        />
                      </div>
                    </div>
                    <div
                      style={{
                        flex: 1,
                        padding: '12px',
                        opacity: 0.25,
                      }}
                    >
                      <div
                        style={{
                          height: '10px',
                          width: '60px',
                          background: '#333',
                          borderRadius: '3px',
                          marginBottom: '10px',
                        }}
                      />
                      <div
                        style={{
                          height: '50px',
                          background: '#1a1a1a',
                          border: '1px solid #2a2a2a',
                          borderRadius: '5px',
                        }}
                      />
                    </div>
                  </div>
                  <h2 className="text-xl font-heading font-bold mb-2">
                    Open Jinxxy&trade; Webhooks
                  </h2>
                  <p
                    className="mb-6"
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '14px',
                      lineHeight: '1.7',
                    }}
                  >
                    Go to your{' '}
                    <strong style={{ color: 'white' }}>Jinxxy&trade; Creator Dashboard</strong> and
                    open the left sidebar. Under the{' '}
                    <strong style={{ color: 'white' }}>Management</strong> section, click{' '}
                    <strong style={{ color: 'white' }}>Webhooks</strong>.
                  </p>
                  <button type="button" className="btn-primary w-full" onClick={handleWizNext}>
                    I'm on the Webhooks page
                  </button>
                </div>
              )}

              {/* Step 2: Paste values */}
              {wizStep === 2 && (
                <div>
                  {/* Visual mockup: New Webhook form */}
                  <div
                    className="rounded-xl overflow-hidden mb-5"
                    style={{
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                    }}
                  >
                    <div
                      style={{
                        background: '#1a1a1a',
                        padding: '8px 12px',
                        borderBottom: '1px solid #2a2a2a',
                        fontSize: '10px',
                        color: '#888',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      New Webhook
                    </div>
                    <div
                      style={{
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: '9px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.07em',
                            color: '#666',
                            marginBottom: '3px',
                            fontWeight: 700,
                          }}
                        >
                          Callback URL
                        </div>
                        <div
                          style={{
                            height: '28px',
                            background: '#0a0a0a',
                            border: '1.5px solid #5865F2',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 8px',
                          }}
                        >
                          <div
                            style={{
                              fontSize: '9px',
                              color: '#8b9cf4',
                              fontFamily: 'monospace',
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {webhookCallbackUrl}
                          </div>
                        </div>
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: '9px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.07em',
                            color: '#666',
                            marginBottom: '3px',
                            fontWeight: 700,
                          }}
                        >
                          Signing Secret
                        </div>
                        <div
                          style={{
                            height: '28px',
                            background: '#0a0a0a',
                            border: '1.5px solid #5865F2',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 8px',
                          }}
                        >
                          <div
                            style={{
                              fontSize: '9px',
                              color: '#8b9cf4',
                              fontFamily: 'monospace',
                              letterSpacing: '0.1em',
                            }}
                          >
                            ••••••••••••••••••••
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <h2 className="text-xl font-heading font-bold mb-2">Add a new webhook</h2>
                  <p
                    className="mb-4"
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '14px',
                      lineHeight: '1.6',
                    }}
                  >
                    Click <strong style={{ color: 'white' }}>New Webhook</strong> in Jinxxy&trade;,
                    paste the callback URL, then create your own signing secret and paste the same
                    value here.
                  </p>
                  <div className="space-y-3 mb-5">
                    <div>
                      <label
                        htmlFor="callback-url-display"
                        className="block text-xs font-bold mb-1.5"
                        style={{
                          color: 'rgba(255,255,255,0.45)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}
                      >
                        Callback URL
                      </label>
                      <div className="flex gap-2">
                        <div id="callback-url-display" className="code-block flex-1 text-xs">
                          {webhookCallbackUrl}
                        </div>
                        <button
                          type="button"
                          className="copy-btn"
                          style={copyBtnColor ? { color: copyBtnColor } : undefined}
                          onClick={() => handleCopyText(webhookCallbackUrl)}
                        >
                          {copyBtnText}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor="signing-secret-input"
                        className="block text-xs font-bold mb-1.5"
                        style={{
                          color: 'rgba(255,255,255,0.45)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}
                      >
                        Signing Secret
                      </label>
                      <input
                        id="signing-secret-input"
                        type="password"
                        className={`input-field${signingSecretError ? ' input-field-error' : ''}`}
                        autoComplete="off"
                        placeholder="Create a long secret, then paste the same value into Jinxxy&trade;"
                        value={signingSecret}
                        onChange={(e) => {
                          setSigningSecret(e.target.value);
                          if (signingSecretError) setSigningSecretError('');
                        }}
                      />
                      {signingSecretError ? (
                        <p className="mt-2 text-xs" style={{ color: '#f87171', lineHeight: '1.5' }}>
                          {signingSecretError}
                        </p>
                      ) : (
                        <p
                          className="mt-2 text-xs"
                          style={{
                            color: 'rgba(255,255,255,0.55)',
                            lineHeight: '1.5',
                          }}
                        >
                          Use at least 16 characters. The Assistant stores it encrypted after you
                          continue.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleWizBack}
                      style={{ flex: '0 0 80px' }}
                    >
                      Back
                    </button>
                    <button type="button" className="btn-primary flex-1" onClick={handleWizNext}>
                      Values pasted - Next
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Select events and save */}
              {wizStep === 3 && (
                <div>
                  {/* Visual mockup: events checklist */}
                  <div
                    className="rounded-xl overflow-hidden mb-5"
                    style={{
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                    }}
                  >
                    <div
                      style={{
                        background: '#1a1a1a',
                        padding: '8px 12px',
                        borderBottom: '1px solid #2a2a2a',
                        fontSize: '10px',
                        color: '#888',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Webhook Events
                    </div>
                    <div
                      style={{
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '7px 9px',
                          background: 'rgba(88,101,242,0.12)',
                          border: '1px solid #5865F2',
                          borderRadius: '4px',
                        }}
                      >
                        <div
                          style={{
                            width: '13px',
                            height: '13px',
                            background: '#5865F2',
                            borderRadius: '3px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <svg aria-hidden="true" width="8" height="6" viewBox="0 0 8 6">
                            <polyline
                              points="1,3 3,5 7,1"
                              stroke="white"
                              strokeWidth="1.5"
                              fill="none"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </div>
                        <span
                          style={{
                            fontSize: '11px',
                            color: '#fff',
                            fontWeight: 600,
                            fontFamily: 'monospace',
                          }}
                        >
                          order.created
                        </span>
                        <span
                          style={{
                            marginLeft: 'auto',
                            fontSize: '8px',
                            color: '#8b9cf4',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                          }}
                        >
                          Check this
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '7px 9px',
                          opacity: 0.3,
                        }}
                      >
                        <div
                          style={{
                            width: '13px',
                            height: '13px',
                            border: '1px solid #555',
                            borderRadius: '3px',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: '11px',
                            color: '#777',
                            fontFamily: 'monospace',
                          }}
                        >
                          order.updated
                        </span>
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '8px 12px',
                        borderTop: '1px solid #2a2a2a',
                        display: 'flex',
                        justifyContent: 'flex-end',
                      }}
                    >
                      <div
                        style={{
                          background: 'rgba(88,101,242,0.15)',
                          border: '1.5px solid #5865F2',
                          color: '#8b9cf4',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '5px 12px',
                          borderRadius: '4px',
                        }}
                      >
                        Save Changes
                      </div>
                    </div>
                  </div>
                  <h2 className="text-xl font-heading font-bold mb-2">Select events and save</h2>
                  <div
                    className="space-y-3 mb-5"
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '14px',
                    }}
                  >
                    <div className="flex gap-3 items-start">
                      <div
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          background: 'rgba(88,101,242,0.2)',
                          border: '1px solid rgba(88,101,242,0.5)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#8b9cf4',
                          marginTop: '1px',
                        }}
                      >
                        1
                      </div>
                      <p>
                        Under <strong style={{ color: 'white' }}>Events</strong>, check{' '}
                        <strong style={{ color: 'white' }}>order.created</strong>. Leave other
                        events unchecked.
                      </p>
                    </div>
                    <div className="flex gap-3 items-start">
                      <div
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          background: 'rgba(88,101,242,0.2)',
                          border: '1px solid rgba(88,101,242,0.5)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#8b9cf4',
                          marginTop: '1px',
                        }}
                      >
                        2
                      </div>
                      <p>
                        Click <strong style={{ color: 'white' }}>Save Changes</strong> to create the
                        webhook.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleWizBack}
                      style={{ flex: '0 0 80px' }}
                    >
                      Back
                    </button>
                    <button type="button" className="btn-primary flex-1" onClick={handleWizNext}>
                      Saved - Next
                    </button>
                  </div>
                </div>
              )}

              {/* Step 4: Test webhook */}
              {wizStep === 4 && (
                <div>
                  {/* Visual: waiting indicator */}
                  <div
                    className="rounded-xl mb-5 flex flex-col items-center justify-center gap-3"
                    style={{
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                      padding: '28px 20px',
                      minHeight: '110px',
                    }}
                  >
                    <div className="flex flex-col items-center gap-2">
                      {testWebhookReceived ? (
                        <>
                          <img src="/Icons/Checkmark.png" width="32" height="32" alt="" />
                          <span
                            style={{
                              fontSize: '13px',
                              color: '#43b581',
                              marginTop: '4px',
                            }}
                          >
                            Test webhook received!
                          </span>
                        </>
                      ) : testWebhookTimedOut ? (
                        <>
                          <img
                            src="/Icons/Timer.png"
                            width="28"
                            height="28"
                            alt=""
                            style={{ opacity: 0.6 }}
                          />
                          <span
                            style={{
                              fontSize: '12px',
                              color: 'rgba(255,165,0,0.8)',
                              marginTop: '4px',
                              textAlign: 'center',
                            }}
                          >
                            Timed out - you can still continue.
                            <br />
                            The webhook may still work once configured.
                          </span>
                        </>
                      ) : (
                        <>
                          <div
                            className="spinner"
                            style={{
                              width: '28px',
                              height: '28px',
                              borderWidth: '2px',
                            }}
                          />
                          <span
                            style={{
                              fontSize: '12px',
                              color: 'rgba(255,255,255,0.35)',
                            }}
                          >
                            Waiting for test webhook...
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <h2 className="text-xl font-heading font-bold mb-2">Send a test webhook</h2>
                  <p
                    className="mb-4"
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '14px',
                      lineHeight: '1.7',
                    }}
                  >
                    Back in Jinxxy&trade; on the Webhooks page, click the{' '}
                    <strong style={{ color: 'white' }}>
                      three dots (&middot;&middot;&middot;)
                    </strong>{' '}
                    next to your new webhook and choose{' '}
                    <strong style={{ color: 'white' }}>Test Webhook</strong>. We'll confirm once we
                    receive it.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleWizBack}
                      style={{ flex: '0 0 80px' }}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn-primary flex-1"
                      disabled={wizTestNextDisabled}
                      onClick={handleWizNext}
                    >
                      {wizTestNextText}
                    </button>
                  </div>
                </div>
              )}

              {/* Step 5: API key */}
              {wizStep === 5 && (
                <div>
                  {/* Visual mockup: API Keys page */}
                  <div
                    className="rounded-xl overflow-hidden mb-5"
                    style={{
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                      display: 'flex',
                      height: '110px',
                    }}
                  >
                    <div
                      style={{
                        width: '120px',
                        background: '#1a1a1a',
                        borderRight: '1px solid #2a2a2a',
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '5px',
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          height: '10px',
                          width: '50px',
                          background: '#333',
                          borderRadius: '3px',
                          marginBottom: '8px',
                        }}
                      />
                      <div
                        style={{
                          height: '8px',
                          width: '85%',
                          background: '#2a2a2a',
                          borderRadius: '2px',
                        }}
                      />
                      <div
                        style={{
                          height: '8px',
                          width: '65%',
                          background: '#2a2a2a',
                          borderRadius: '2px',
                        }}
                      />
                      <div
                        style={{
                          height: '6px',
                          width: '40%',
                          background: '#444',
                          borderRadius: '2px',
                          marginTop: '6px',
                          marginBottom: '2px',
                        }}
                      />
                      {/* Highlighted API Keys */}
                      <div
                        style={{
                          padding: '5px 7px',
                          background: 'rgba(88,101,242,0.15)',
                          border: '1px solid #5865F2',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <img
                          src="/Icons/Key.png"
                          width="10"
                          height="10"
                          alt=""
                          style={{ flexShrink: 0, opacity: 0.8 }}
                        />
                        <div
                          style={{
                            height: '7px',
                            width: '36px',
                            background: '#8b9cf4',
                            borderRadius: '2px',
                            opacity: 0.7,
                          }}
                        />
                      </div>
                    </div>
                    <div style={{ flex: 1, padding: '10px' }}>
                      <div
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#fff',
                          marginBottom: '7px',
                        }}
                      >
                        API Keys
                      </div>
                      <div
                        style={{
                          background: 'rgba(88,101,242,0.1)',
                          border: '1px solid rgba(88,101,242,0.35)',
                          borderRadius: '4px',
                          padding: '6px 9px',
                          fontSize: '9px',
                          color: '#8b9cf4',
                          fontWeight: 700,
                          display: 'inline-block',
                          marginBottom: '6px',
                        }}
                      >
                        + New API Key
                      </div>
                      <div
                        style={{
                          fontSize: '8px',
                          color: '#555',
                          lineHeight: '1.5',
                        }}
                      >
                        products_read, orders_read,
                        <br />
                        licenses_read
                      </div>
                    </div>
                  </div>
                  <h2 className="text-xl font-heading font-bold mb-2">
                    Create and paste your API key
                  </h2>
                  <p
                    className="mb-4"
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '14px',
                      lineHeight: '1.7',
                    }}
                  >
                    In Jinxxy&trade;, go to{' '}
                    <strong style={{ color: 'white' }}>Settings &rarr; API Keys</strong> and click{' '}
                    <strong style={{ color: 'white' }}>New API Key</strong>. Enable these scopes:{' '}
                    <code
                      style={{
                        fontSize: '12px',
                        background: 'rgba(255,255,255,0.08)',
                        padding: '1px 5px',
                        borderRadius: '3px',
                      }}
                    >
                      products_read
                    </code>{' '}
                    <code
                      style={{
                        fontSize: '12px',
                        background: 'rgba(255,255,255,0.08)',
                        padding: '1px 5px',
                        borderRadius: '3px',
                      }}
                    >
                      orders_read
                    </code>{' '}
                    <code
                      style={{
                        fontSize: '12px',
                        background: 'rgba(255,255,255,0.08)',
                        padding: '1px 5px',
                        borderRadius: '3px',
                      }}
                    >
                      licenses_read
                    </code>
                    . Then paste your key below.
                  </p>
                  <div className="mb-3">
                    <input
                      type="password"
                      className="input-field"
                      placeholder={providerUI.placeholder}
                      autoComplete="off"
                      value={accountApiKey}
                      onChange={(e) => setAccountApiKey(e.target.value)}
                    />
                  </div>
                  {accountError && <div className="warning-box mb-3">{accountError}</div>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleWizBack}
                      style={{ flex: '0 0 80px' }}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn-primary flex-1"
                      disabled={accountSubmitting}
                      onClick={submitAccountLinking}
                    >
                      {accountSubmitting ? 'Connecting...' : 'Connect'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Stage 4b: API Linking Form */}
          {activeStage === 'stage-api-form' && (
            <div className="ci-card fade-in">
              {/* Visual mockup: API Keys page */}
              <div
                className="rounded-xl overflow-hidden mb-5"
                style={{
                  background: '#0f0f0f',
                  border: '1px solid #2a2a2a',
                  display: 'flex',
                  height: '100px',
                }}
              >
                <div
                  style={{
                    width: '120px',
                    background: '#1a1a1a',
                    borderRight: '1px solid #2a2a2a',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '5px',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      height: '10px',
                      width: '50px',
                      background: '#333',
                      borderRadius: '3px',
                      marginBottom: '8px',
                    }}
                  />
                  <div
                    style={{
                      height: '8px',
                      width: '85%',
                      background: '#2a2a2a',
                      borderRadius: '2px',
                    }}
                  />
                  <div
                    style={{
                      height: '8px',
                      width: '65%',
                      background: '#2a2a2a',
                      borderRadius: '2px',
                    }}
                  />
                  <div
                    style={{
                      height: '6px',
                      width: '40%',
                      background: '#444',
                      borderRadius: '2px',
                      marginTop: '6px',
                      marginBottom: '2px',
                    }}
                  />
                  <div
                    style={{
                      padding: '5px 7px',
                      background: 'rgba(88,101,242,0.15)',
                      border: '1px solid #5865F2',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <img
                      src="/Icons/Key.png"
                      width="10"
                      height="10"
                      alt=""
                      style={{ flexShrink: 0, opacity: 0.8 }}
                    />
                    <div
                      style={{
                        height: '7px',
                        width: '36px',
                        background: '#8b9cf4',
                        borderRadius: '2px',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                </div>
                <div style={{ flex: 1, padding: '10px' }}>
                  <div
                    style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      color: '#fff',
                      marginBottom: '7px',
                    }}
                  >
                    API Keys
                  </div>
                  <div
                    style={{
                      background: 'rgba(88,101,242,0.1)',
                      border: '1px solid rgba(88,101,242,0.35)',
                      borderRadius: '4px',
                      padding: '6px 9px',
                      fontSize: '9px',
                      color: '#8b9cf4',
                      fontWeight: 700,
                      display: 'inline-block',
                      marginBottom: '6px',
                    }}
                  >
                    + New API Key
                  </div>
                  <div
                    style={{
                      fontSize: '8px',
                      color: '#555',
                      lineHeight: '1.5',
                    }}
                  >
                    products_read, orders_read,
                    <br />
                    licenses_read
                  </div>
                </div>
              </div>

              <h2 className="text-xl font-heading font-bold mb-3">{providerUI.apiFormHeading}</h2>

              <div className="warning-box mb-4">
                <strong>Manual verification only</strong> - users must run /verify manually. There
                is no automatic role assignment when someone makes a purchase.
              </div>

              <p
                className="mb-4"
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '14px',
                  lineHeight: '1.7',
                }}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted provider instructions from plugin registry
                dangerouslySetInnerHTML={{
                  __html: providerUI.apiFormInstructions,
                }}
              />

              <div className="mb-3">
                <input
                  type="password"
                  className="input-field"
                  placeholder={providerUI.placeholder}
                  autoComplete="off"
                  value={apiFormKey}
                  onChange={(e) => setApiFormKey(e.target.value)}
                />
              </div>

              {apiFormError && <div className="warning-box mb-3">{apiFormError}</div>}
              <button
                type="button"
                className="btn-primary w-full"
                disabled={apiSubmitting}
                onClick={submitApiLinking}
              >
                {apiSubmitting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          )}

          {/* Stage 5: Success */}
          {activeStage === 'stage-success' && (
            <div className="ci-card fade-in text-center">
              <div className="check-circle">
                <img src="/Icons/Checkmark.png" width="28" height="28" alt="" />
              </div>
              <h2 className="text-2xl font-heading font-bold mb-3">You're connected!</h2>
              <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
                {successMessage}
              </p>
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
                You can close this tab.
              </p>
            </div>
          )}

          {/* Error screen */}
          {activeStage === 'stage-error' && (
            <div className="ci-card fade-in text-center">
              <div className="ci-error-circle">
                <img src="/Icons/X.png" width="28" height="28" alt="" />
              </div>
              <h2 className="text-xl font-heading font-bold mb-3">{errorTitle}</h2>
              <p style={{ color: 'var(--text-secondary)' }}>{errorMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/collab-invite')({
  validateSearch: (search: Record<string, unknown>) => ({
    auth: typeof search.auth === 'string' ? search.auth : undefined,
    t:
      typeof search.t === 'string'
        ? search.t
        : typeof search.token === 'string'
          ? search.token
          : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Collaborator Invite | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.collabInvite),
  }),
  component: CollabInvitePage,
});
