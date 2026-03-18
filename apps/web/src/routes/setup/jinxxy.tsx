import { createFileRoute } from '@tanstack/react-router';
import confetti from 'canvas-confetti';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BellRing,
  Check,
  CheckCircle,
  Copy,
  ExternalLink,
  Inbox,
  Key,
  PartyPopper,
  Plus,
  RefreshCw,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/setup/jinxxy')({
  head: () => ({
    meta: [{ title: 'Connect Jinxxy\u2122 | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.jinxxySetup),
  }),
  component: JinxxySetupPage,
});

const API_BASE = '';
const TOTAL_STEPS = 7;
const SIGNING_SECRET_MIN = 16;
const SIGNING_SECRET_MAX = 40;

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, SIGNING_SECRET_MAX);
}

function apiFetch(url: string, options: RequestInit = {}) {
  return fetch(url, { credentials: 'include', ...options });
}

function JinxxySetupPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhookConfigLoaded, setWebhookConfigLoaded] = useState(false);
  const [webhookConfigError, setWebhookConfigError] = useState<string | null>(null);
  const [testWebhookReceived, setTestWebhookReceived] = useState(false);
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishSuccess, setFinishSuccess] = useState(false);
  const [isSavingSecret, setIsSavingSecret] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [testMockText, setTestMockText] = useState('Listening for test event...');
  const [testMockColor, setTestMockColor] = useState('text-[#0ea5e9]');

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepsSlotRef = useRef<HTMLDivElement>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);

  // Read URL params
  const params =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const tenantId = params.get('tenant_id') || params.get('tenantId') || '';
  const guildId = params.get('guild_id') || params.get('guildId') || '';
  const hasSetupSessionParam = params.get('has_setup_session') === 'true';

  const hasTenant = tenantId && tenantId !== '__TENANT_ID__';

  const dashboardUrl = (() => {
    if (!hasTenant || typeof window === 'undefined') return null;
    const url = new URL(`${API_BASE}/dashboard`, window.location.origin);
    url.searchParams.set('tenant_id', tenantId);
    if (guildId && guildId !== '__GUILD_ID__') url.searchParams.set('guild_id', guildId);
    return url.toString();
  })();

  // Bootstrap session from URL hash on mount
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (hasSetupSessionParam) {
        setIsVisible(true);
        return;
      }
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const setupToken = hash.get('s');
      if (!setupToken) {
        setIsVisible(true);
        return;
      }

      try {
        const res = await apiFetch(`${API_BASE}/api/connect/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupToken }),
        });

        if (!res.ok) {
          const errorUrl = new URL(`${API_BASE}/verify-error`, window.location.origin);
          errorUrl.searchParams.set('error', 'link_expired');
          window.location.replace(errorUrl.toString());
          return;
        }

        window.history.replaceState({}, '', window.location.pathname + window.location.search);
        window.location.reload();
      } catch {
        if (!cancelled) setIsVisible(true);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [hasSetupSessionParam]);

  // Update steps slot height when step changes
  const updateStepsHeight = useCallback(() => {
    const slot = stepsSlotRef.current;
    if (!slot) return;
    const active = slot.querySelector('.step-content.active') as HTMLElement | null;
    if (active) {
      slot.style.height = `${active.offsetHeight}px`;
    }
  }, []);

  useEffect(() => {
    updateStepsHeight();
    const observer = new ResizeObserver(() => updateStepsHeight());
    const slot = stepsSlotRef.current;
    if (slot) {
      const active = slot.querySelector('.step-content.active') as HTMLElement | null;
      if (active) observer.observe(active);
    }
    return () => observer.disconnect();
  }, [updateStepsHeight]);

  // Fetch webhook config on step 3
  useEffect(() => {
    if (currentStep !== 3) return;
    let cancelled = false;

    async function loadConfig() {
      try {
        const configUrl =
          hasSetupSessionParam || !tenantId
            ? `${API_BASE}/api/connect/jinxxy/webhook-config`
            : API_BASE +
              '/api/connect/jinxxy/webhook-config?tenantId=' +
              encodeURIComponent(tenantId);
        const res = await apiFetch(configUrl);
        const data = await res.json();
        if (cancelled) return;
        if (data.callbackUrl) {
          setCallbackUrl(data.callbackUrl);
          setWebhookConfigLoaded(true);
          setWebhookConfigError(null);
          setSigningSecret((prev) => {
            if (!prev || prev.length < SIGNING_SECRET_MIN) return generateSecret();
            return prev;
          });
        } else {
          setWebhookConfigError('Failed to load webhook config.');
        }
      } catch {
        if (!cancelled) setWebhookConfigError('Failed to load webhook config.');
      }
    }

    loadConfig();
    return () => {
      cancelled = true;
    };
  }, [currentStep, hasSetupSessionParam, tenantId]);

  // Poll for test webhook on step 5
  useEffect(() => {
    if (currentStep !== 5) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    setTestWebhookReceived(false);
    setTestMockText('Listening for test event...');
    setTestMockColor('text-[#0ea5e9]');

    pollIntervalRef.current = setInterval(async () => {
      try {
        const testUrl =
          hasSetupSessionParam || !tenantId
            ? `${API_BASE}/api/connect/jinxxy/test-webhook`
            : API_BASE +
              '/api/connect/jinxxy/test-webhook?tenantId=' +
              encodeURIComponent(tenantId);
        const res = await apiFetch(testUrl);
        const data = await res.json();
        if (data.received) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setTestWebhookReceived(true);
          setTestMockText('Received!');
          setTestMockColor('text-green-400');
        }
      } catch {
        // keep polling
      }
    }, 2500);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [currentStep, hasSetupSessionParam, tenantId]);

  // Confetti on reaching step 7
  useEffect(() => {
    if (currentStep === TOTAL_STEPS) {
      confetti({ particleCount: 30, spread: 50, origin: { y: 0.8 } });
    }
  }, [currentStep]);

  const handleCopy = useCallback(async (text: string, id: string, e?: React.MouseEvent) => {
    await navigator.clipboard.writeText(text);
    setCopied((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => setCopied((prev) => ({ ...prev, [id]: false })), 2000);

    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (rect.left + rect.width / 2) / window.innerWidth;
      const y = (rect.top + rect.height / 2) / window.innerHeight;
      confetti({
        particleCount: 15,
        spread: 40,
        origin: { x, y },
        colors: ['#0ea5e9', '#ffffff'],
        disableForReducedMotion: true,
        scalar: 0.6,
        startVelocity: 10,
      });
    }
  }, []);

  const isStep3Valid =
    signingSecret.length >= SIGNING_SECRET_MIN && signingSecret.length <= SIGNING_SECRET_MAX;

  const goBackToDashboard = useCallback(() => {
    let url = `${API_BASE}/dashboard?tenant_id=${encodeURIComponent(tenantId)}`;
    if (guildId) url += `&guild_id=${encodeURIComponent(guildId)}`;
    window.location.href = url;
  }, [tenantId, guildId]);

  const handleNext = useCallback(async () => {
    if (currentStep === 3) {
      if (!isStep3Valid) return;
      setIsSavingSecret(true);
      setError(null);
      try {
        const configUrl = hasSetupSessionParam
          ? `${API_BASE}/api/connect/jinxxy/webhook-config`
          : API_BASE +
            '/api/connect/jinxxy/webhook-config?tenantId=' +
            encodeURIComponent(tenantId);
        const res = await apiFetch(configUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhookSecret: signingSecret }),
        });
        if (!res.ok) throw new Error('Could not save your signing secret.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save your signing secret.');
        setIsSavingSecret(false);
        return;
      }
      setIsSavingSecret(false);
    }

    if (currentStep < TOTAL_STEPS) {
      setCurrentStep((s) => s + 1);
    }
  }, [currentStep, isStep3Valid, signingSecret, hasSetupSessionParam, tenantId]);

  const handlePrev = useCallback(() => {
    if (currentStep > 1) setCurrentStep((s) => s - 1);
  }, [currentStep]);

  const handleFinish = useCallback(async () => {
    const trimmedKey = apiKey.trim();
    setError(null);

    if (!trimmedKey) {
      setError('Please enter your Jinxxy\u2122 API key.');
      return;
    }

    // Fire confetti stream
    const end = Date.now() + 1500;
    (function frame() {
      confetti({
        particleCount: 4,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ['#0ea5e9', '#ffffff', '#ffeb3b'],
      });
      confetti({
        particleCount: 4,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ['#0ea5e9', '#ffffff', '#ffeb3b'],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();

    setIsFinishing(true);

    try {
      const body: Record<string, string> = { apiKey: trimmedKey };
      if (tenantId) body.tenantId = tenantId;
      if (
        signingSecret &&
        signingSecret.length >= SIGNING_SECRET_MIN &&
        signingSecret.length <= SIGNING_SECRET_MAX
      ) {
        body.webhookSecret = signingSecret;
      }

      const res = await apiFetch(`${API_BASE}/api/connect/jinxxy-store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Could not save this Jinxxy\u2122 connection right now.');
      await res.json();

      setFinishSuccess(true);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      setTimeout(() => goBackToDashboard(), 1500);
    } catch {
      setError(
        'Could not save this Jinxxy\u2122 connection right now. Check the key and try again.'
      );
      setIsFinishing(false);
    }
  }, [apiKey, tenantId, signingSecret, goBackToDashboard]);

  const nextDisabled = (() => {
    if (isSavingSecret) return true;
    if (currentStep === 3) return !isStep3Valid;
    if (currentStep === 5) return !testWebhookReceived;
    return false;
  })();

  const stepDots = Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1);

  return (
    <div className="jinxxy-setup fixed inset-0 flex flex-col items-center justify-center overflow-hidden">
      <div
        className={`page-content fixed inset-0 flex flex-col items-center justify-center overflow-hidden${isVisible ? ' is-visible' : ''}`}
        style={!isVisible ? { opacity: 0 } : undefined}
      >
        {/* Back to Dashboard */}
        {dashboardUrl && (
          <a
            href={dashboardUrl}
            className="fixed top-6 left-6 z-50 inline-flex items-center gap-2 px-4 py-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl text-white/80 hover:text-white hover:bg-white/10 transition-all font-bold text-sm shadow-xl"
            style={{ textDecoration: 'none' }}
          >
            <svg
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

        {/* Background canvas */}
        <BackgroundCanvasRoot position="absolute" />

        <main className="flex flex-1 items-center justify-center p-4 lg:p-8 relative w-full max-w-7xl mx-auto min-h-0 overflow-hidden">
          {/* Background animations */}
          <div className="absolute top-10 left-10 w-64 h-64 border border-[#ffffff]/5 rounded-full pointer-events-none animate-[spin_60s_linear_infinite]" />
          <div className="absolute bottom-10 right-10 w-96 h-96 border border-[#0ea5e9]/5 rounded-full pointer-events-none animate-[spin_80s_linear_infinite_reverse]" />
          <svg
            className="absolute top-1/4 right-20 w-32 h-32 opacity-10 pointer-events-none"
            viewBox="0 0 100 100"
          >
            <rect
              x="0"
              y="0"
              width="100"
              height="100"
              fill="none"
              stroke="#ffffff"
              strokeWidth="1"
            />
            <line x1="0" y1="0" x2="100" y2="100" stroke="#ffffff" strokeWidth="1" />
          </svg>

          {/* Main card */}
          <div className="w-full max-w-6xl max-h-[calc(100%-2rem)] bg-black/25 backdrop-blur-xl rounded-[40px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] p-5 sm:p-8 md:p-12 relative overflow-hidden flex flex-col z-10">
            {/* Header */}
            <div className="flex flex-wrap justify-between items-end gap-4 mb-6 md:mb-8 pb-4 flex-shrink-0">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#ffeb3b]/20 text-[#ffffff] rounded-full text-[10px] font-black uppercase tracking-widest mb-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0ea5e9] animate-pulse" />
                  Integration Setup
                </div>
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-[#ffffff]">
                  Connect <span className="text-[#0ea5e9]">Jinxxy&#8482;</span>
                </h1>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className="text-sm font-bold text-[rgba(255,255,255,0.8)]">
                  Step <span>{currentStep}</span> of {TOTAL_STEPS}
                </span>
                <div className="flex gap-1.5">
                  {stepDots.map((idx) => {
                    const isActive = idx <= currentStep;
                    const isCurrent = idx === currentStep;
                    return (
                      <div
                        key={idx}
                        className={`h-1.5 rounded-full transition-all duration-500 ${
                          isActive ? 'bg-[#0ea5e9]' : 'bg-white/10'
                        } ${isCurrent ? 'w-8' : 'w-2'}`}
                      />
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Steps container */}
            <div
              className="relative min-h-0 flex-1 overflow-y-auto steps-container"
              ref={stepsContainerRef}
            >
              <div ref={stepsSlotRef} className="steps-slot pr-2">
                {/* Step 1: Navigate to Webhooks */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 1 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] group transform transition-transform hover:scale-[1.01] duration-500">
                    <div className="absolute inset-0 flex font-sans">
                      <div className="w-64 bg-[#1a1a1a] border-r border-[#333] p-4 flex flex-col gap-1 z-10">
                        <div className="h-8 w-24 bg-gradient-to-r from-gray-700 to-gray-800 rounded mb-6 opacity-50" />
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-16 bg-gray-700 rounded" />
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-20 bg-gray-700 rounded" />
                        </div>
                        <div className="mt-8 mb-2 px-2 text-[9px] uppercase tracking-wider text-gray-500 font-bold">
                          Management
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-12 bg-gray-700 rounded" />
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded bg-[#0ea5e9]/10 text-white border border-[#0ea5e9] relative">
                          <div className="w-4 h-4 rounded bg-[#0ea5e9] flex items-center justify-center">
                            <Webhook className="w-3 h-3 text-white" />
                          </div>
                          <div className="text-xs font-medium">Webhooks</div>
                          <div className="absolute -right-2 top-1/2 -translate-y-1/2 translate-x-full flex items-center">
                            <div className="w-20 h-[1px] bg-[#0ea5e9]" />
                            <div className="w-3 h-3 rounded-full bg-[#0ea5e9]" />
                          </div>
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-14 bg-gray-700 rounded" />
                        </div>
                      </div>
                      <div className="flex-1 bg-[#0f0f0f] p-8 flex flex-col gap-6 opacity-50 blur-[1px]">
                        <div className="h-8 w-32 bg-gray-800 rounded" />
                        <div className="w-full h-full bg-[#1a1a1a] border border-[#333] rounded-lg" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Navigate to <br />
                      Webhooks
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-lg leading-relaxed">
                      Start by opening your Jinxxy&#8482; Creator Dashboard. In the left sidebar,
                      scroll down to the <strong className="text-[#ffffff]">Management</strong>{' '}
                      section and click on <strong className="text-[#ffffff]">Webhooks</strong>.
                    </p>
                    <a
                      href="https://dashboard.jinxxy.com/webhooks"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-[#0ea5e9] text-white font-bold shadow-lg shadow-[#0ea5e9]/20 hover:bg-[#0ea5e9]/90 hover:scale-[1.02] transition-all w-full sm:w-auto min-h-[44px]"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open Jinxxy&#8482; Webhooks
                    </a>
                  </div>
                </div>

                {/* Step 2: Create a New Webhook */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 2 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] flex flex-col p-8 font-sans">
                    <div className="flex justify-between items-center mb-8">
                      <div className="flex items-center gap-3">
                        <span className="text-gray-400 text-xs">Dashboard</span>
                        <span className="text-gray-600 text-xs">/</span>
                        <span className="text-white font-bold text-lg">Webhooks</span>
                      </div>
                      <div className="relative group">
                        <div className="absolute -inset-2 bg-[#0ea5e9]/30 rounded-lg blur opacity-75 animate-pulse" />
                        <button
                          type="button"
                          className="relative bg-white/10 text-white px-4 py-2 rounded text-xs font-bold hover:bg-white/10 transition-colors flex items-center gap-2 border-2 border-[#0ea5e9] glow-highlight"
                        >
                          <Plus className="w-3 h-3" />
                          New Webhook
                        </button>
                        <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 text-[#0ea5e9] flex flex-col items-center">
                          <ArrowUp className="w-6 h-6 animate-bounce" />
                          <span className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">
                            Click Here
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 bg-[#1a1a1a] rounded border border-[#333] overflow-hidden">
                      <div className="h-10 border-b border-[#333] flex items-center px-4 gap-4 bg-[#222]">
                        <div className="h-2 w-4 bg-gray-700 rounded" />
                        <div className="h-2 w-24 bg-gray-700 rounded" />
                        <div className="ml-auto h-2 w-16 bg-gray-700 rounded" />
                      </div>
                      <div className="flex flex-col items-center justify-center h-32 text-gray-600 text-xs gap-2">
                        <Inbox className="w-8 h-8 opacity-20" />
                        No webhooks found
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Create a New <br />
                      Webhook
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-lg leading-relaxed">
                      On the Webhooks page, locate the{' '}
                      <strong className="text-[#ffffff]">New Webhook</strong> button in the top
                      right corner and click it to open the creation modal.
                    </p>
                    <p className="text-sm text-amber-400/90">
                      <strong>Reconnecting?</strong> Delete any existing Creator Assistant webhook
                      in Jinxxy&#8482; first, then create this new one. Old webhooks use a different
                      secret and will be rejected.
                    </p>
                  </div>
                </div>

                {/* Step 3: Enter Webhook Details */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 3 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] flex items-center justify-center p-8 bg-opacity-95">
                    <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#333] rounded-lg shadow-2xl relative font-sans">
                      <div className="border-b border-[#333] p-4 flex justify-between items-center">
                        <span className="text-white font-bold text-sm">Creating Webhook</span>
                        <div className="w-2 h-2 rounded-full bg-red-500" />
                      </div>
                      <div className="p-6 space-y-6">
                        <div className="space-y-2">
                          <div className="text-[10px] text-gray-400 uppercase font-bold">
                            Callback URL
                          </div>
                          <div className="h-9 w-full bg-[#0f0f0f] border border-[#0ea5e9] rounded px-3 flex items-center relative shadow-[0_0_10px_rgba(212,93,57,0.2)]">
                            <div className="w-1 h-4 bg-[#0ea5e9] animate-pulse" />
                            <div className="absolute -left-3 top-1/2 -translate-y-1/2 -translate-x-full flex items-center">
                              <div className="px-2 py-1 bg-[#0ea5e9] text-white text-[9px] font-bold rounded mr-2">
                                PASTE HERE
                              </div>
                              <div className="w-8 h-[1px] bg-[#0ea5e9]" />
                            </div>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="text-[10px] text-gray-400 uppercase font-bold">
                            Signing Secret
                          </div>
                          <div className="h-9 w-full bg-[#0f0f0f] border border-[#333] rounded px-3 flex items-center" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Enter Webhook <br />
                      Details
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-base leading-relaxed">
                      Copy the values below and paste them into the corresponding fields in the
                      Jinxxy&#8482; modal.
                    </p>

                    {!webhookConfigLoaded && !webhookConfigError && (
                      <div className="text-[rgba(255,255,255,0.8)]">Loading webhook config...</div>
                    )}
                    {webhookConfigError && (
                      <div className="text-[rgba(255,255,255,0.8)]">{webhookConfigError}</div>
                    )}
                    {error && currentStep === 3 && (
                      <div className="text-[rgba(255,255,255,0.8)]">{error}</div>
                    )}
                    {webhookConfigLoaded && (
                      <div className="space-y-4 pt-2">
                        {/* Callback URL field */}
                        <div className="group">
                          <label className="block text-xs font-bold uppercase tracking-wider text-[rgba(255,255,255,0.8)] mb-1.5 flex items-center gap-2">
                            Callback URL
                            <span className="text-[9px] bg-white/10 text-[#ffffff] px-1.5 py-0.5 rounded">
                              Required
                            </span>
                          </label>
                          <div className="webhook-field-ring flex items-center gap-2 bg-white/5 p-1 pl-3 rounded-xl border-smooth-transition shadow-sm">
                            <code className="flex-1 text-sm font-mono text-[#ffffff] truncate select-all">
                              {callbackUrl}
                            </code>
                            <button
                              type="button"
                              className={`copy-btn p-2.5 bg-white/10 shadow-sm border border-white/10 hover:border-[#0ea5e9] rounded-lg text-[rgba(255,255,255,0.8)] hover:text-[#0ea5e9] border-smooth-transition${copied.callbackUrl ? ' copied' : ''}`}
                              onClick={(e) => handleCopy(callbackUrl, 'callbackUrl', e)}
                            >
                              <Copy className="w-4 h-4 copy-icon" />
                              <Check className="w-4 h-4 checkmark text-green-500" />
                            </button>
                          </div>
                        </div>

                        {/* Signing Secret field */}
                        <div className="group">
                          <label className="block text-xs font-bold uppercase tracking-wider text-[rgba(255,255,255,0.8)] mb-1.5 flex items-center gap-2">
                            Signing Secret
                            <span className="text-[9px] bg-white/10 text-[#ffffff] px-1.5 py-0.5 rounded">
                              Choose your own
                            </span>
                          </label>
                          <div className="webhook-field-ring flex items-center gap-2 bg-white/5 p-1 pl-3 rounded-xl border-smooth-transition shadow-sm">
                            <input
                              type="password"
                              autoComplete="off"
                              maxLength={40}
                              placeholder="16-40 characters, paste the same value into Jinxxy\u2122"
                              value={signingSecret}
                              onChange={(e) => setSigningSecret(e.target.value)}
                              className="flex-1 min-w-0 px-2 py-2.5 rounded-lg border-0 bg-transparent focus:ring-0 outline-none transition-colors text-[#ffffff] placeholder:text-white/40"
                            />
                            <button
                              type="button"
                              className="flex-shrink-0 p-2.5 bg-white/10 shadow-sm border border-white/10 hover:border-[#0ea5e9] rounded-lg text-[rgba(255,255,255,0.8)] hover:text-[#0ea5e9] border-smooth-transition"
                              title="Generate a secure random secret"
                              onClick={() => setSigningSecret(generateSecret())}
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              className={`copy-btn flex-shrink-0 p-2.5 bg-white/10 shadow-sm border border-white/10 hover:border-[#0ea5e9] rounded-lg text-[rgba(255,255,255,0.8)] hover:text-[#0ea5e9] border-smooth-transition${copied.signingSecret ? ' copied' : ''}`}
                              title="Copy signing secret"
                              onClick={(e) => handleCopy(signingSecret, 'signingSecret', e)}
                            >
                              <Copy className="w-4 h-4 copy-icon" />
                              <Check className="w-4 h-4 checkmark text-green-500" />
                            </button>
                          </div>
                          <p className="mt-2 text-xs text-[rgba(255,255,255,0.65)]">
                            Between 16 and 40 characters. Jinxxy&#8482; limits the signing secret
                            length. The Assistant stores it encrypted after you continue.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Step 4: Select Events & Save */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 4 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] flex items-center justify-center p-8 bg-opacity-95">
                    <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#333] rounded-lg shadow-2xl relative font-sans flex flex-col h-[300px]">
                      <div className="border-b border-[#333] p-4">
                        <div className="h-4 w-24 bg-gray-700 rounded" />
                      </div>
                      <div className="p-6 space-y-6 flex-1">
                        <div className="space-y-3">
                          <div className="text-[10px] text-gray-400 uppercase font-bold">
                            Events
                          </div>
                          <div className="flex items-center gap-3 p-3 bg-[#0ea5e9]/10 border border-[#0ea5e9] rounded relative">
                            <div className="w-5 h-5 bg-[#0ea5e9] rounded flex items-center justify-center shadow-lg shadow-[#0ea5e9]/50">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-white text-sm font-medium">order.created</span>
                            <div className="absolute -right-4 top-1/2 -translate-y-1/2 translate-x-full flex items-center">
                              <div className="w-12 h-[1px] bg-[#0ea5e9]" />
                              <span className="text-[#0ea5e9] text-[9px] font-bold uppercase tracking-wider ml-2">
                                Check This
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 p-2 opacity-30">
                            <div className="w-5 h-5 border border-gray-600 rounded" />
                            <span className="text-gray-400 text-sm">order.updated</span>
                          </div>
                        </div>
                      </div>
                      <div className="p-4 border-t border-[#333] flex justify-end">
                        <div className="bg-white/10 text-white px-4 py-2 rounded text-xs font-bold border-2 border-[#0ea5e9] shadow-[0_0_15px_rgba(212,93,57,0.3)]">
                          Save Changes
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Select Events <br />
                      {'&'} Save
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <div className="bg-white/10 p-5 rounded-xl shadow-sm space-y-4">
                      <div className="flex items-start gap-4">
                        <div className="w-6 h-6 rounded-full bg-[#ffeb3b]/20 flex items-center justify-center mt-0.5 flex-shrink-0 text-[#ffffff] font-bold text-xs">
                          1
                        </div>
                        <p className="text-[rgba(255,255,255,0.8)] text-sm leading-relaxed">
                          Under &quot;What events do you want to be sent?&quot;, ensure{' '}
                          <strong className="text-[#ffffff]">order.created</strong> is checked.
                        </p>
                      </div>
                      <div className="flex items-start gap-4">
                        <div className="w-6 h-6 rounded-full bg-[#0ea5e9]/10 flex items-center justify-center mt-0.5 flex-shrink-0 text-[#0ea5e9] font-bold text-xs">
                          2
                        </div>
                        <p className="text-[rgba(255,255,255,0.8)] text-sm leading-relaxed">
                          Click <strong className="text-[#0ea5e9]">Save Changes</strong> to create
                          the webhook.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Step 5: Receive Test Webhook */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 5 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] flex items-center justify-center p-8 bg-opacity-95 text-white font-sans">
                    <div className="flex flex-col items-center gap-6">
                      <div className="relative">
                        <BellRing className={`w-12 h-12 relative z-10 ${testMockColor}`} />
                        <div className="absolute inset-0 bg-[#0ea5e9] rounded-full blur-xl opacity-50 animate-pulse" />
                      </div>
                      <span
                        className={`text-sm font-medium tracking-wide ${testWebhookReceived ? 'text-green-400' : 'text-gray-400'}`}
                      >
                        {testMockText}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Receive Test
                      <br />
                      Webhook
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-base leading-relaxed">
                      Click the three dots on your webhook row in Jinxxy&#8482;, then{' '}
                      <strong className="text-[#ffffff]">Test webhook</strong>. We'll confirm when
                      we receive it.
                    </p>

                    {!testWebhookReceived && (
                      <div className="flex items-center gap-3 p-4 rounded-xl">
                        <span className="text-[rgba(255,255,255,0.8)]">
                          Waiting for test webhook...
                        </span>
                        <div className="animate-spin h-5 w-5 border-2 border-[#0ea5e9] border-t-transparent rounded-full" />
                      </div>
                    )}

                    {testWebhookReceived && (
                      <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 flex items-center gap-2">
                        <CheckCircle className="w-5 h-5 flex-shrink-0" />
                        <span>Test webhook received!</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Step 6: Navigate to API Keys */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 6 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] group transform transition-transform hover:scale-[1.01] duration-500">
                    <div className="absolute inset-0 flex font-sans">
                      <div className="w-64 bg-[#1a1a1a] border-r border-[#333] p-4 flex flex-col gap-1 z-10">
                        <div className="h-8 w-24 bg-gray-700 rounded mb-6 opacity-30" />
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-16 bg-gray-700 rounded" />
                        </div>
                        <div className="mt-8 mb-2 px-2 text-[9px] uppercase tracking-wider text-gray-500 font-bold">
                          Management
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-12 bg-gray-700 rounded" />
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded jinxxy-sidebar-item">
                          <div className="w-4 h-4 rounded bg-gray-700" />
                          <div className="h-2 w-16 bg-gray-700 rounded" />
                        </div>
                        <div className="flex items-center gap-3 p-2 rounded bg-[#0ea5e9]/10 text-white border border-[#0ea5e9] relative mt-1">
                          <div className="w-4 h-4 rounded bg-[#0ea5e9] flex items-center justify-center">
                            <Key className="w-3 h-3 text-white" />
                          </div>
                          <div className="text-xs font-medium">API Keys</div>
                          <div className="absolute -right-2 top-1/2 -translate-y-1/2 translate-x-full flex items-center">
                            <div className="w-20 h-[1px] bg-[#0ea5e9]" />
                            <div className="w-3 h-3 rounded-full bg-[#0ea5e9]" />
                          </div>
                        </div>
                      </div>
                      <div className="flex-1 bg-[#0f0f0f] p-8 flex flex-col gap-6 opacity-50 blur-[1px]">
                        <div className="h-8 w-24 bg-gray-800 rounded" />
                        <div className="w-full h-32 bg-[#1a1a1a] border border-[#333] rounded-lg flex items-center justify-center text-gray-700 text-xs">
                          No keys found
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Navigate to <br />
                      API Keys
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-lg leading-relaxed">
                      Back in the sidebar under Management, click on{' '}
                      <strong className="text-[#ffffff]">API Keys</strong>. We need to create a key
                      to fetch your product details securely.
                    </p>
                  </div>
                </div>

                {/* Step 7: Create Key & Enter API Key */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center${currentStep === 7 ? ' active' : ''}`}
                >
                  <div className="relative bg-[#0f0f0f] rounded-2xl overflow-hidden shadow-2xl border border-gray-800 aspect-[16/10] flex items-center justify-center p-8 bg-opacity-95">
                    <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#333] rounded-lg shadow-2xl relative font-sans flex flex-col">
                      <div className="border-b border-[#333] p-4 text-white text-sm font-bold">
                        Creating API Key
                      </div>
                      <div className="p-6 space-y-4">
                        <div className="space-y-2">
                          <div className="text-[10px] text-gray-400 uppercase font-bold">
                            Description
                          </div>
                          <div className="h-9 w-full bg-[#0f0f0f] border border-[#0ea5e9] rounded px-3 flex items-center text-xs text-white">
                            Creator Assistant Integration
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="text-[10px] text-gray-400 uppercase font-bold">
                            Access
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 bg-[#0ea5e9] rounded-sm" />
                              <div className="h-2 w-16 bg-gray-600 rounded" />
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 bg-[#0ea5e9] rounded-sm" />
                              <div className="h-2 w-12 bg-gray-600 rounded" />
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 bg-[#0ea5e9] rounded-sm" />
                              <div className="h-2 w-14 bg-gray-600 rounded" />
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 bg-[#0ea5e9] rounded-sm" />
                              <div className="h-2 w-10 bg-gray-600 rounded" />
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="p-4 border-t border-[#333] flex justify-end">
                        <div className="bg-white/10 text-white px-4 py-2 rounded text-xs font-bold border-2 border-[#0ea5e9]">
                          Save Changes
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-[#ffffff] leading-tight">
                      Create Key {'&'}
                      <br />
                      Enter API Key
                    </h2>
                    <div className="w-12 h-1 bg-[#0ea5e9]" />
                    <p className="text-[rgba(255,255,255,0.8)] text-sm leading-relaxed mb-2">
                      Click &quot;New API Key&quot;, check these scopes:{' '}
                      <strong>products_read</strong>, <strong>orders_read</strong>,{' '}
                      <strong>customers_read</strong>, <strong>licenses_read</strong>. Note: this
                      changed from the old Koji method. Use these ones here, they are far safer!
                    </p>

                    <div className="space-y-3 mb-4">
                      <label className="block text-xs font-bold uppercase tracking-wider text-[rgba(255,255,255,0.8)] mb-1">
                        Jinxxy&#8482; API Key
                      </label>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder="Paste your Jinxxy\u2122 API key"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border-2 border-white/20 focus:border-[#0ea5e9] focus:ring-0 outline-none transition-colors text-[#ffffff]"
                      />
                    </div>

                    {error && currentStep === 7 && (
                      <div className="text-red-600 text-sm font-bold">{error}</div>
                    )}

                    {currentStep === TOTAL_STEPS && (
                      <button
                        type="button"
                        disabled={isFinishing}
                        onClick={handleFinish}
                        className={`w-full py-4 text-white rounded-xl font-bold shadow-lg shadow-[#ffffff]/20 hover:scale-[1.02] transition-transform flex items-center justify-center gap-2 group ${
                          finishSuccess ? 'bg-green-600' : 'bg-white/5 backdrop-blur-md'
                        } ${isFinishing ? 'opacity-90 pointer-events-none' : ''}`}
                      >
                        {finishSuccess ? (
                          <>
                            <span>Connected Successfully!</span>
                            <CheckCircle className="w-5 h-5" />
                          </>
                        ) : isFinishing ? (
                          <span>Verifying Connection...</span>
                        ) : (
                          <>
                            <span className="group-hover:tracking-wider transition-all">
                              Complete Setup
                            </span>
                            <PartyPopper className="w-5 h-5 animate-bounce" />
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Navigation buttons */}
            <div className="mt-auto pt-8 flex flex-col-reverse sm:flex-row justify-between items-stretch sm:items-center gap-3 flex-shrink-0 relative z-20">
              <button
                type="button"
                disabled={currentStep === 1}
                onClick={handlePrev}
                className="px-6 py-3 rounded-xl font-bold text-[rgba(255,255,255,0.8)] hover:text-[#ffffff] hover:bg-white/5 disabled:opacity-30 disabled:hover:text-[rgba(255,255,255,0.8)] disabled:hover:bg-transparent transition-colors flex items-center justify-center gap-2 min-h-[44px]"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              {currentStep < TOTAL_STEPS && (
                <button
                  type="button"
                  disabled={nextDisabled}
                  onClick={handleNext}
                  className="px-8 py-3 rounded-xl bg-[#0ea5e9] text-white font-bold shadow-lg shadow-[#0ea5e9]/20 hover:bg-[#0ea5e9]/90 hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 group min-h-[44px]"
                >
                  {isSavingSecret ? 'Saving Secret...' : 'Next Step'}
                  {!isSavingSecret && (
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  )}
                </button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
