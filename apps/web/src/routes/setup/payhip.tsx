import { createFileRoute } from '@tanstack/react-router';
import confetti from 'canvas-confetti';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Copy,
  PartyPopper,
  PlusCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiClient } from '@/api/client';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { buildSetupAuthQuery, withSetupAuthUserId } from '@/lib/setupAuth';
import '@/styles/payhip-setup.css';

export const Route = createFileRoute('/setup/payhip')({
  head: () => ({
    meta: [{ title: 'Connect Payhip | Creator Assistant' }],
  }),
  component: PayhipSetupPage,
});

/* ── Types ─────────────────────────────────────────────── */

interface Product {
  id: number;
  permalink: string;
  secretKey: string;
}

interface FinishResponse {
  webhookUrl: string;
}

interface TestWebhookResponse {
  received: boolean;
}

/* ── Bootstrap helper ──────────────────────────────────── */

async function bootstrapSetupSession(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const setupToken = hash.get('s');
  if (!setupToken) return false;
  try {
    await apiClient.post('/api/connect/bootstrap', { setupToken });
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
    window.location.reload();
    return true;
  } catch {
    const errorUrl = new URL('/verify-error', window.location.origin);
    errorUrl.searchParams.set('error', 'link_expired');
    window.location.replace(errorUrl.toString());
    return true;
  }
}

/* ── Helpers ───────────────────────────────────────────── */

function getTenantId(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return params.get('tenant_id') || params.get('tenantId') || '';
}

function getGuildId(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return params.get('guild_id') || params.get('guildId') || '';
}

function getDashboardUrl(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const tenantId = getTenantId();
  const guildId = getGuildId();
  const url = new URL('/dashboard', window.location.origin);
  if (tenantId) url.searchParams.set('tenant_id', tenantId);
  if (guildId) url.searchParams.set('guild_id', guildId);
  return url.toString();
}

/* ── Mockup SVG icons ──────────────────────────────────── */

function MockCheckSvg() {
  return (
    <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
      <path
        d="M2 5l2.5 2.5L8 3"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CustomerSvg() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#505060"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function CreatorBotSvg() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#3b82f6"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="7" width="18" height="13" rx="3" />
      <path d="M9 7V5a3 3 0 016 0v2" />
      <circle cx="9" cy="14" r="1.2" fill="#3b82f6" stroke="none" />
      <circle cx="15" cy="14" r="1.2" fill="#3b82f6" stroke="none" />
    </svg>
  );
}

function DiscordSvg() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#5865f2">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.001.022.01.043.027.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

/* ── Component ─────────────────────────────────────────── */

const TOTAL_STEPS = 4;
let productIdCounter = 0;

function PayhipSetupPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [apiKey, setApiKey] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [testWebhookReceived, setTestWebhookReceived] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepsSlotRef = useRef<HTMLDivElement>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);

  /* ── Bootstrap on mount ──────────────────────────────── */
  useEffect(() => {
    setIsVisible(true);
    bootstrapSetupSession().catch(() => {});
  }, []);

  /* ── Update steps-slot height on step change ─────────── */
  const updateStepsHeight = useCallback(() => {
    if (!stepsSlotRef.current) return;
    const active = stepsSlotRef.current.querySelector('.step-content.active') as HTMLElement | null;
    if (active) {
      stepsSlotRef.current.style.height = `${active.offsetHeight}px`;
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(updateStepsHeight, 50);
    return () => clearTimeout(timer);
  }, [updateStepsHeight]);

  useEffect(() => {
    const onResize = () => updateStepsHeight();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateStepsHeight]);

  /* ── Webhook polling ─────────────────────────────────── */
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const tenantId = getTenantId();
    pollRef.current = setInterval(async () => {
      try {
        const data = await apiClient.get<TestWebhookResponse>(
          buildSetupAuthQuery('/api/connect/payhip/test-webhook', tenantId)
        );
        if (data.received) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTestWebhookReceived(true);
        }
      } catch {
        // polling errors are silently ignored
      }
    }, 2500);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (currentStep === 3 && !testWebhookReceived) {
      startPolling();
    } else {
      stopPolling();
    }
    return stopPolling;
  }, [currentStep, testWebhookReceived, startPolling, stopPolling]);

  useEffect(() => {
    window.addEventListener('beforeunload', stopPolling);
    return () => window.removeEventListener('beforeunload', stopPolling);
  }, [stopPolling]);

  /* ── Copy to clipboard ───────────────────────────────── */
  const copyToClipboard = useCallback((text: string, key: string, el?: HTMLElement | null) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setCopied((prev) => ({ ...prev, [key]: false })), 2000);
      if (el) {
        const rect = el.getBoundingClientRect();
        confetti({
          particleCount: 12,
          spread: 40,
          origin: {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight,
          },
          colors: ['#3b82f6', '#ffffff'],
          disableForReducedMotion: true,
          scalar: 0.6,
          startVelocity: 10,
        });
      }
    });
  }, []);

  /* ── Step 1 → 2: Save API key ────────────────────────── */
  const saveApiKey = useCallback(async () => {
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Please enter your Payhip API key.');
      return false;
    }
    setIsSavingApiKey(true);
    try {
      const tenantId = getTenantId();
      const body = withSetupAuthUserId({ apiKey: trimmed }, tenantId);
      const data = await apiClient.post<FinishResponse>('/api/connect/payhip-finish', body);
      setWebhookUrl(data.webhookUrl ?? '');
      return true;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? ((err.body as Record<string, string> | null)?.error ??
            'Could not save API key. Please try again.')
          : 'Could not save API key. Please try again.';
      setError(message);
      return false;
    } finally {
      setIsSavingApiKey(false);
    }
  }, [apiKey]);

  /* ── Step 4: Save product keys ───────────────────────── */
  const saveProductKeys = useCallback(async () => {
    setError(null);
    const tenantId = getTenantId();
    const toSave = products.filter((p) => p.permalink.trim() && p.secretKey.trim());
    for (const item of toSave) {
      const body = withSetupAuthUserId({
        permalink: item.permalink.trim(),
        productSecretKey: item.secretKey.trim(),
      }, tenantId);
      try {
        await apiClient.post('/api/connect/payhip/product-key', body);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? ((err.body as Record<string, string> | null)?.error ?? 'unknown error')
            : 'unknown error';
        setError(`Failed to save "${item.permalink}": ${message}`);
        return false;
      }
    }
    return true;
  }, [products]);

  /* ── Product row management ──────────────────────────── */
  const addProduct = useCallback(() => {
    productIdCounter += 1;
    setProducts((prev) => [...prev, { id: productIdCounter, permalink: '', secretKey: '' }]);
  }, []);

  const removeProduct = useCallback((id: number) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const updateProduct = useCallback(
    (id: number, field: 'permalink' | 'secretKey', value: string) => {
      setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
    },
    []
  );

  /* ── Navigation ──────────────────────────────────────── */
  const goNext = useCallback(async () => {
    if (currentStep === 1) {
      const ok = await saveApiKey();
      if (!ok) return;
    }
    if (currentStep < TOTAL_STEPS) {
      const next = currentStep + 1;
      setError(null);
      setCurrentStep(next);
      if (next === TOTAL_STEPS) {
        setProducts((prev) => {
          if (prev.length === 0) {
            productIdCounter += 1;
            return [{ id: productIdCounter, permalink: '', secretKey: '' }];
          }
          return prev;
        });
        confetti({ particleCount: 30, spread: 50, origin: { y: 0.8 } });
      }
    }
  }, [currentStep, saveApiKey]);

  const goPrev = useCallback(() => {
    if (currentStep > 1) {
      setError(null);
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  const finishSetup = useCallback(async () => {
    setError(null);
    setIsFinishing(true);
    const end = Date.now() + 1500;
    (function frame() {
      confetti({
        particleCount: 4,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ['#3b82f6', '#ffffff', '#22c55e'],
      });
      confetti({
        particleCount: 4,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ['#3b82f6', '#ffffff', '#22c55e'],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
    const ok = await saveProductKeys();
    if (ok) {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      setTimeout(() => {
        window.location.href = getDashboardUrl();
      }, 1500);
    } else {
      setIsFinishing(false);
    }
  }, [saveProductKeys]);

  /* ── Step dot styles ─────────────────────────────────── */
  const dotStyle = (index: number): string => {
    if (index < currentStep) return 'h-[5px] w-2 rounded-full bg-[#3b82f6] step-dot';
    if (index === currentStep) return 'h-[5px] w-8 rounded-full bg-[#3b82f6] step-dot';
    return 'h-[5px] w-2 rounded-full bg-white/10 step-dot';
  };

  /* ── Step content class ──────────────────────────────── */
  const stepClass = (step: number): string => {
    const base = 'step-content';
    const grid =
      step === 4
        ? 'grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-14 items-start'
        : 'grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-14 items-center';
    return currentStep === step ? `${base} active ${grid}` : `${base} ${grid}`;
  };

  /* ── Render ──────────────────────────────────────────── */
  const tenantId = getTenantId();
  const _guildId = getGuildId();
  const showBackBtn = !!tenantId;

  return (
    <div
      className="payhip-setup fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ fontFamily: "'DM Sans', sans-serif", color: '#fff' }}
    >
      <div
        className={`page-content fixed inset-0 flex flex-col items-center justify-center overflow-hidden${isVisible ? ' is-visible' : ''}`}
      >
        <BackgroundCanvasRoot position="absolute" />

        {/* Back to dashboard */}
        {showBackBtn && (
          <a
            href={getDashboardUrl()}
            className="fixed top-6 left-6 z-50 inline-flex items-center gap-2 px-4 py-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-all font-bold text-sm shadow-xl"
            style={{ textDecoration: 'none' }}
          >
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2.5} />
            Dashboard
          </a>
        )}

        {/* Ambient ring decorations */}
        <div className="absolute top-10 left-10 w-64 h-64 border border-[#ffffff]/5 rounded-full pointer-events-none animate-[spin_60s_linear_infinite]" />
        <div className="absolute bottom-10 right-10 w-96 h-96 border border-[#0ea5e9]/5 rounded-full pointer-events-none animate-[spin_80s_linear_infinite_reverse]" />
        <svg
          className="absolute top-1/4 right-20 w-32 h-32 opacity-10 pointer-events-none"
          viewBox="0 0 100 100"
        >
          <rect x="0" y="0" width="100" height="100" fill="none" stroke="#ffffff" strokeWidth="1" />
          <line x1="0" y1="0" x2="100" y2="100" stroke="#ffffff" strokeWidth="1" />
        </svg>

        <main className="flex flex-1 items-center justify-center p-4 lg:p-8 relative w-full max-w-7xl mx-auto min-h-0 overflow-hidden">
        <div className="card-shell w-full max-w-6xl max-h-[calc(100%-2rem)] bg-black/25 backdrop-blur-xl rounded-[40px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] p-5 sm:p-8 md:p-12 relative overflow-hidden flex flex-col z-10">
          {/* ── Header ──────────────────────────────────── */}
          <div className="flex flex-wrap justify-between items-end gap-4 mb-6 md:mb-8 pb-5 border-b border-white/[0.06] flex-shrink-0">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded-full text-[9px] font-black uppercase tracking-[0.13em] text-blue-300 mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] animate-pulse" />
                Integration Setup
              </div>
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                Connect <span className="text-[#3b82f6]">Payhip</span>
              </h1>
            </div>
            <div className="flex flex-col items-end gap-2.5">
              <span className="text-xs font-bold text-white/40">
                Step {currentStep} <span className="opacity-40">/ {TOTAL_STEPS}</span>
              </span>
              <div className="flex gap-1.5 items-center">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={dotStyle(i)} />
                ))}
              </div>
            </div>
          </div>

          {/* ── Steps container ─────────────────────────── */}
          <div
            className="relative min-h-0 flex-1 overflow-y-auto steps-container"
            ref={stepsContainerRef}
          >
            <div className="steps-slot" ref={stepsSlotRef}>
              {/* ═══════════ STEP 1 - Find API Key ═══════════ */}
              <div className={stepClass(1)} data-step="1">
                {/* Mockup: Payhip Developer Settings - API Key */}
                <div className="mockup-col mockup-shell">
                  <div className="traffic-lights">
                    <div className="tl tl-r" />
                    <div className="tl tl-y" />
                    <div className="tl tl-g" />
                    <div className="mock-urlbar">payhip.com/account/developer</div>
                  </div>
                  <div className="ph-body">
                    <div className="ph-topnav">
                      <span className="ph-logo">Payhip</span>
                      <span className="ph-nav-item">Dashboard</span>
                      <span className="ph-nav-item">Products</span>
                      <span className="ph-nav-item">Orders</span>
                      <span className="ph-nav-item active">Settings</span>
                    </div>
                    <div className="ph-main">
                      <div className="ph-page-title">Developer Settings</div>
                      {/* API Key card - highlighted */}
                      <div className="ph-card highlighted">
                        <div className="ph-field-label">API Key</div>
                        <div className="ph-input-row active" style={{ overflow: 'visible' }}>
                          <div className="ph-dot" />
                          <span className="ph-key-text">{'•'.repeat(20)}</span>
                          <span className="ph-copy-chip">Copy</span>
                          <div className="ph-callout">
                            <div className="ph-callout-line" />
                            <div className="ph-callout-tag">Copy this</div>
                          </div>
                        </div>
                      </div>
                      {/* Other section - dimmed */}
                      <div className="ph-card dimmed">
                        <div className="ph-field-label">Webhook Settings</div>
                        <div className="ph-sk w-full" />
                        <div className="ph-sk" style={{ width: '55%' }} />
                      </div>
                      <div className="ph-card dimmed" style={{ opacity: 0.14, marginTop: 'auto' }}>
                        <div className="ph-sk" style={{ width: '70%' }} />
                        <div className="ph-sk" style={{ width: '40%' }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Instructions */}
                <div className="instructions-col space-y-5">
                  <div>
                    <h2 className="text-[1.75rem] sm:text-3xl font-extrabold text-white leading-tight tracking-tight">
                      Find Your
                      <br />
                      <span className="text-[#3b82f6]">API Key</span>
                    </h2>
                    <div
                      className="h-[3px] w-10 rounded-full bg-[#3b82f6] mt-3"
                      style={{ opacity: 0.7 }}
                    />
                  </div>
                  <div className="inst-card">
                    <div className="inst-row">
                      <div className="inst-num">1</div>
                      <p className="text-white/60 text-sm leading-relaxed">
                        Log into <strong className="text-white">payhip.com</strong>, click your
                        account name, then navigate to{' '}
                        <strong className="text-white">Settings &rarr; Developer</strong>.
                      </p>
                    </div>
                    <div className="inst-row">
                      <div className="inst-num">2</div>
                      <p className="text-white/60 text-sm leading-relaxed">
                        Copy the <strong className="text-white">API Key</strong> shown on that page
                        and paste it below.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-white/30">
                      Payhip API Key
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Paste your Payhip API key"
                      className="api-key-input"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </div>
                  {error && currentStep === 1 && (
                    <div className="text-red-300 text-sm font-semibold bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                      {error}
                    </div>
                  )}
                </div>
              </div>

              {/* ═══════════ STEP 2 - Configure Webhook ═══════════ */}
              <div className={stepClass(2)} data-step="2">
                {/* Mockup: Payhip Developer Settings - Webhooks */}
                <div className="mockup-col mockup-shell">
                  <div className="traffic-lights">
                    <div className="tl tl-r" />
                    <div className="tl tl-y" />
                    <div className="tl tl-g" />
                    <div className="mock-urlbar">payhip.com/account/developer</div>
                  </div>
                  <div className="ph-body">
                    <div className="ph-topnav">
                      <span className="ph-logo">Payhip</span>
                      <span className="ph-nav-item">Dashboard</span>
                      <span className="ph-nav-item">Products</span>
                      <span className="ph-nav-item">Orders</span>
                      <span className="ph-nav-item active">Settings</span>
                    </div>
                    <div className="ph-main">
                      <div className="ph-page-title">Developer Settings</div>
                      {/* API Key - dimmed */}
                      <div className="ph-card dimmed">
                        <div className="ph-field-label">API Key</div>
                        <div className="ph-input-row">
                          <div
                            className="ph-dot"
                            style={{ background: '#d1d5db', boxShadow: 'none' }}
                          />
                          <span className="ph-key-text" style={{ color: '#9ca3af' }}>
                            {'•'.repeat(12)}
                          </span>
                        </div>
                      </div>
                      {/* Webhook - highlighted */}
                      <div className="ph-card highlighted">
                        <div className="ph-field-label">Webhook Endpoint</div>
                        <div
                          className="ph-input-row active"
                          style={{ overflow: 'visible', paddingRight: '4px' }}
                        >
                          <span
                            className="ph-key-text"
                            style={{
                              fontSize: '7px',
                              letterSpacing: 0,
                              color: '#2563eb',
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {webhookUrl || 'https://\u2026/webhooks/payhip/\u2026'}
                          </span>
                          <div className="ph-callout">
                            <div className="ph-callout-line" />
                            <div className="ph-callout-tag">Paste here</div>
                          </div>
                        </div>
                        <div className="ph-field-label" style={{ marginTop: '2px' }}>
                          Webhook Events
                        </div>
                        <div className="ph-event-row">
                          <div className="ph-event-chip">
                            <div className="ph-checkmark-box">
                              <MockCheckSvg />
                            </div>
                            paid
                          </div>
                          <div className="ph-event-chip">
                            <div className="ph-checkmark-box">
                              <MockCheckSvg />
                            </div>
                            refunded
                          </div>
                        </div>
                        <div className="ph-save-btn">Save Changes</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Instructions */}
                <div className="instructions-col space-y-5">
                  <div>
                    <h2 className="text-[1.75rem] sm:text-3xl font-extrabold text-white leading-tight tracking-tight">
                      Configure
                      <br />
                      <span className="text-[#3b82f6]">Webhook</span>
                    </h2>
                    <div
                      className="h-[3px] w-10 rounded-full bg-[#3b82f6] mt-3"
                      style={{ opacity: 0.7 }}
                    />
                  </div>

                  {!webhookUrl ? (
                    <div className="flex items-center gap-3 text-white/35 text-sm">
                      <div className="w-4 h-4 border-2 border-white/10 border-t-[#3b82f6] rounded-full animate-spin flex-shrink-0" />
                      Generating webhook URL...
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="block text-[10px] font-bold uppercase tracking-widest text-white/30">
                          Your Webhook URL
                        </label>
                        <div className="flex items-center gap-2">
                          <div className="code-block flex-1">{webhookUrl}</div>
                          <button
                            className={`copy-btn flex-shrink-0 w-9 h-9 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.09] flex items-center justify-center transition-colors${copied.webhook ? ' copied' : ''}`}
                            title="Copy"
                            onClick={(e) => copyToClipboard(webhookUrl, 'webhook', e.currentTarget)}
                          >
                            <Copy className="w-4 h-4 copy-icon text-white/50" />
                            <Check className="w-4 h-4 checkmark text-[#3b82f6]" />
                          </button>
                        </div>
                      </div>
                      <div className="inst-card">
                        <div className="inst-row">
                          <div className="inst-num">1</div>
                          <p className="text-white/60 text-sm leading-relaxed">
                            In Payhip, go to{' '}
                            <strong className="text-white">Settings &rarr; Developer</strong> and
                            paste the URL above into the{' '}
                            <strong className="text-white">Webhook Endpoint</strong> field.
                          </p>
                        </div>
                        <div className="inst-row">
                          <div className="inst-num">2</div>
                          <p className="text-white/60 text-sm leading-relaxed">
                            Under <strong className="text-white">Webhook Events</strong>, enable{' '}
                            <strong className="text-white">paid</strong> and{' '}
                            <strong className="text-white">refunded</strong>. Then save.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ═══════════ STEP 3 - Test Webhook ═══════════ */}
              <div className={stepClass(3)} data-step="3">
                {/* Mockup: Webhook signal monitor */}
                <div className="mockup-col mockup-shell">
                  <div className="traffic-lights">
                    <div className="tl tl-r" />
                    <div className="tl tl-y" />
                    <div className="tl tl-g" />
                    <div className="mock-urlbar">Webhook signal monitor</div>
                  </div>
                  <div className="flow-shell">
                    <div className="flow-row">
                      {/* Node: Customer */}
                      <div className="flow-node">
                        <div className="flow-icon">
                          <CustomerSvg />
                        </div>
                        <span className="flow-label">Customer</span>
                      </div>
                      {/* Edge 1 */}
                      <div className="flow-edge">
                        <div className="flow-sig" />
                      </div>
                      {/* Node: Payhip */}
                      <div className="flow-node">
                        <div
                          className="flow-icon"
                          style={{
                            background: 'rgba(59,130,246,0.06)',
                            borderColor: 'rgba(59,130,246,0.2)',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "'Plus Jakarta Sans',sans-serif",
                              fontWeight: 800,
                              fontSize: '14px',
                              color: '#3b82f6',
                            }}
                          >
                            P
                          </span>
                        </div>
                        <span className="flow-label">Payhip</span>
                      </div>
                      {/* Edge 2 */}
                      <div className="flow-edge">
                        <div className="flow-sig d1" />
                      </div>
                      {/* Node: Creator Bot (waiting/active) */}
                      <div
                        className={`flow-node ${testWebhookReceived ? 'flow-node-success' : 'flow-node-waiting'}`}
                      >
                        <div
                          className={`flow-icon ${testWebhookReceived ? 'is-success' : 'is-waiting'}`}
                        >
                          {!testWebhookReceived && (
                            <>
                              <div className="flow-ripple" />
                              <div className="flow-ripple-2" />
                            </>
                          )}
                          <CreatorBotSvg />
                        </div>
                        <span className="flow-label">Creator Bot</span>
                      </div>
                      {/* Edge 3 */}
                      <div className="flow-edge">
                        <div className="flow-sig d2" />
                      </div>
                      {/* Node: Discord */}
                      <div className="flow-node">
                        <div className="flow-icon">
                          <DiscordSvg />
                        </div>
                        <span className="flow-label">Discord</span>
                      </div>
                    </div>
                    {/* Status text in mockup */}
                    <span
                      className={`text-[9px] font-bold uppercase tracking-[0.12em] ${
                        testWebhookReceived ? 'text-green-400' : 'text-[#383840]'
                      }`}
                    >
                      {testWebhookReceived ? 'Received!' : 'Listening for test event\u2026'}
                    </span>
                  </div>
                </div>

                {/* Instructions */}
                <div className="instructions-col space-y-5">
                  <div>
                    <h2 className="text-[1.75rem] sm:text-3xl font-extrabold text-white leading-tight tracking-tight">
                      Test the
                      <br />
                      <span className="text-[#3b82f6]">Webhook</span>
                    </h2>
                    <div
                      className="h-[3px] w-10 rounded-full bg-[#3b82f6] mt-3"
                      style={{ opacity: 0.7 }}
                    />
                  </div>
                  <p className="text-white/60 text-sm leading-relaxed">
                    Make a test purchase in your Payhip store, or trigger an event from Payhip's{' '}
                    <strong className="text-white">Developer Settings</strong>. We'll confirm the
                    moment we receive it.
                  </p>

                  {!testWebhookReceived ? (
                    <div className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.04] border border-white/[0.07]">
                      <div className="animate-spin h-5 w-5 border-2 border-[#3b82f6] border-t-transparent rounded-full flex-shrink-0" />
                      <span className="text-white/50 text-sm">Waiting for webhook event...</span>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center gap-3">
                      <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
                      <span className="text-green-300 font-semibold text-sm">
                        Webhook received! Payhip is connected.
                      </span>
                    </div>
                  )}

                  <p className="text-[11px] text-white/25 italic leading-relaxed">
                    You can skip this and proceed -- role assignment will work automatically once
                    the webhook is configured.
                  </p>
                </div>
              </div>

              {/* ═══════════ STEP 4 - Product Secret Keys ═══════════ */}
              <div className={stepClass(4)} data-step="4">
                {/* Mockup: Payhip product edit - License Keys */}
                <div className="mockup-col mockup-shell">
                  <div className="traffic-lights">
                    <div className="tl tl-r" />
                    <div className="tl tl-y" />
                    <div className="tl tl-g" />
                    <div className="mock-urlbar">payhip.com/account/products/edit</div>
                  </div>
                  <div className="ph-body">
                    <div className="ph-topnav">
                      <span className="ph-logo">Payhip</span>
                      <span className="ph-nav-item">Dashboard</span>
                      <span className="ph-nav-item active">Products</span>
                      <span className="ph-nav-item">Orders</span>
                      <span className="ph-nav-item">Settings</span>
                    </div>
                    <div className="ph-main">
                      <div className="ph-page-title">Edit Product</div>
                      <div className="ph-product-header">
                        <div className="ph-product-thumb" />
                        <span className="ph-product-name">My Digital Product</span>
                      </div>
                      {/* Dimmed basic field */}
                      <div className="ph-card dimmed">
                        <div className="ph-field-label">Product Name</div>
                        <div className="ph-sk w-full" />
                      </div>
                      {/* Advanced Options */}
                      <div className="ph-adv-row">
                        <div className="ph-adv-chevron" />
                        Advanced Options
                      </div>
                      {/* License Keys - highlighted */}
                      <div className="ph-card highlighted">
                        <div className="ph-lic-check">
                          <div className="ph-checkmark-box">
                            <MockCheckSvg />
                          </div>
                          Generate unique license keys for each sale
                        </div>
                        <div className="ph-field-label">Product Secret Key</div>
                        <div className="ph-input-row active" style={{ overflow: 'visible' }}>
                          <div className="ph-dot" />
                          <span className="ph-key-text">sk_{'•'.repeat(16)}</span>
                          <div className="ph-callout">
                            <div className="ph-callout-line" />
                            <div className="ph-callout-tag">Copy this</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Instructions + form */}
                <div className="instructions-col space-y-5">
                  <div>
                    <h2 className="text-[1.75rem] sm:text-3xl font-extrabold text-white leading-tight tracking-tight">
                      Link Your
                      <br />
                      <span className="text-[#3b82f6]">Products</span>
                    </h2>
                    <div
                      className="h-[3px] w-10 rounded-full bg-[#3b82f6] mt-3"
                      style={{ opacity: 0.7 }}
                    />
                  </div>
                  <div className="inst-card">
                    <div className="inst-row">
                      <div className="inst-num">1</div>
                      <p className="text-white/60 text-sm leading-relaxed">
                        Open a product in Payhip &rarr;{' '}
                        <strong className="text-white">Edit Product &rarr; Advanced Options</strong>
                        . Check{' '}
                        <strong className="text-white">
                          Generate unique license keys for each sale
                        </strong>
                        , then save the product.
                      </p>
                    </div>
                    <div className="inst-row">
                      <div className="inst-num">2</div>
                      <p className="text-white/60 text-sm leading-relaxed">
                        After saving, scroll back down to{' '}
                        <strong className="text-white">Advanced Options</strong> -- the{' '}
                        <strong className="text-white">Product Secret Key</strong> will now be
                        visible. Copy it and paste it below.
                      </p>
                    </div>
                    <div className="inst-row">
                      <div className="inst-num">3</div>
                      <p className="text-white/60 text-sm leading-relaxed">
                        The <strong className="text-white">permalink</strong> is the short code from
                        your product URL -- e.g.{' '}
                        <code className="text-[#93c5fd] font-mono text-xs bg-[#3b82f6]/10 px-1 py-0.5 rounded">
                          payhip.com/b/<strong>RGsF</strong>
                        </code>{' '}
                        &rarr; permalink is{' '}
                        <code className="text-[#93c5fd] font-mono text-xs">RGsF</code>.
                      </p>
                    </div>
                  </div>

                  {/* Product rows */}
                  <div className="space-y-3">
                    {products.map((product) => (
                      <div key={product.id} className="product-card product-row">
                        <button
                          className="remove-product-btn"
                          title="Remove"
                          onClick={() => removeProduct(product.id)}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                        <div className="product-card-fields">
                          <div>
                            <label className="product-card-label">Permalink</label>
                            <input
                              type="text"
                              className="api-key-input product-permalink"
                              placeholder="e.g. RGsF"
                              style={{
                                fontFamily: "'DM Sans',sans-serif",
                                fontSize: '14px',
                                letterSpacing: 'normal',
                              }}
                              value={product.permalink}
                              onChange={(e) =>
                                updateProduct(product.id, 'permalink', e.target.value)
                              }
                            />
                          </div>
                          <div>
                            <label className="product-card-label">Secret Key</label>
                            <input
                              type="password"
                              className="api-key-input product-secret-key"
                              placeholder="From product edit page"
                              value={product.secretKey}
                              onChange={(e) =>
                                updateProduct(product.id, 'secretKey', e.target.value)
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    className="flex items-center gap-2 text-sm text-[#3b82f6] hover:text-blue-300 transition-colors font-semibold w-full justify-center py-2.5 border border-dashed border-[#3b82f6]/25 rounded-xl hover:border-[#3b82f6]/50 hover:bg-[#3b82f6]/5"
                    onClick={addProduct}
                  >
                    <PlusCircle className="w-4 h-4" />
                    Add a product
                  </button>

                  {error && currentStep === 4 && (
                    <div className="text-red-300 text-sm font-semibold bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                      {error}
                    </div>
                  )}

                  <p className="text-[11px] text-white/20 italic">
                    You can skip this and add product keys later from the dashboard.
                  </p>
                </div>
              </div>
            </div>
            {/* /steps-slot */}
          </div>
          {/* /steps-container */}

          {/* ── Navigation ──────────────────────────────── */}
          <div
            className="mt-auto pt-6 flex flex-col-reverse sm:flex-row justify-between items-stretch sm:items-center gap-3 flex-shrink-0 relative z-20 border-t border-white/[0.05]"
            style={{ paddingTop: '20px', marginTop: '20px' }}
          >
            <button
              className="px-6 py-3 rounded-xl font-bold text-white/50 hover:text-white hover:bg-white/[0.05] disabled:opacity-25 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 min-h-[44px]"
              disabled={currentStep === 1}
              onClick={goPrev}
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>

            {currentStep < TOTAL_STEPS ? (
              <button
                className="px-8 py-3 rounded-xl bg-[#3b82f6] text-white font-bold shadow-lg shadow-[#3b82f6]/20 hover:bg-[#2563eb] hover:scale-[1.02] disabled:opacity-40 disabled:pointer-events-none transition-all flex items-center justify-center gap-2 group min-h-[44px]"
                disabled={isSavingApiKey}
                onClick={goNext}
              >
                {isSavingApiKey ? (
                  'Saving\u2026'
                ) : (
                  <>
                    Next Step{' '}
                    <ArrowRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </button>
            ) : (
              <button
                className={`w-full sm:w-auto px-8 py-3 backdrop-blur-md text-white rounded-xl font-bold shadow-lg hover:scale-[1.02] transition-transform flex items-center justify-center gap-2 group min-h-[44px] ${
                  isFinishing ? 'bg-green-600' : 'bg-white/[0.07]'
                }`}
                disabled={isFinishing}
                onClick={finishSetup}
              >
                {isFinishing ? (
                  <span>Saving...</span>
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
        </main>
      </div>
    </div>
  );
}
