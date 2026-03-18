import { createFileRoute } from '@tanstack/react-router';
import confetti from 'canvas-confetti';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  Home,
  Mail,
  PenTool,
  Plus,
  Settings,
  Sliders,
  Store,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/setup/lemonsqueezy')({
  head: () => ({
    meta: [{ title: 'Connect Lemon Squeezy® | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.lemonsqueezySetup),
  }),
  component: LemonSqueezySetupPage,
});

function getUrlParams(): {
  tenantId: string;
  guildId: string;
  apiBase: string;
} {
  if (typeof window === 'undefined') return { tenantId: '', guildId: '', apiBase: '' };
  const params = new URLSearchParams(window.location.search);
  return {
    tenantId: params.get('tenant_id') ?? '',
    guildId: params.get('guild_id') ?? '',
    apiBase: params.get('api_base') ?? '',
  };
}

async function apiFetch(url: string, opts: RequestInit = {}) {
  return fetch(url, { credentials: 'include', ...opts });
}

async function bootstrapSetupSession(apiBase: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const setupToken = hash.get('s');
  if (!setupToken) return false;
  const res = await apiFetch(`${apiBase}/api/connect/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken }),
  });
  if (!res.ok) {
    const u = new URL(`${apiBase}/verify-error`, window.location.origin);
    u.searchParams.set('error', 'link_expired');
    window.location.replace(u.toString());
    return true;
  }
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  window.location.reload();
  return true;
}

function LemonSqueezySetupPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const stepsSlotRef = useRef<HTMLDivElement>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  const { tenantId, guildId, apiBase } = getUrlParams();

  const totalSteps = 2;

  const goBackToDashboard = useCallback(() => {
    let url = `${apiBase}/dashboard?tenant_id=${encodeURIComponent(tenantId)}`;
    if (guildId) url += `&guild_id=${encodeURIComponent(guildId)}`;
    window.location.href = url;
  }, [apiBase, tenantId, guildId]);

  const dashboardUrl = (() => {
    if (!tenantId || typeof window === 'undefined') return null;
    const u = new URL(`${apiBase}/dashboard`, window.location.origin);
    u.searchParams.set('tenant_id', tenantId);
    if (guildId) u.searchParams.set('guild_id', guildId);
    return u.toString();
  })();

  const updateStepsHeight = useCallback((stepNum?: number) => {
    const slot = stepsSlotRef.current;
    if (!slot) return;
    const selector =
      stepNum != null ? `.step-content[data-step="${stepNum}"]` : '.step-content.active';
    const target = slot.querySelector<HTMLElement>(selector);
    if (target) slot.style.height = `${target.offsetHeight}px`;
  }, []);

  useEffect(() => {
    setIsVisible(true);
    bootstrapSetupSession(apiBase).catch(() => {});
  }, [apiBase]);

  useEffect(() => {
    updateStepsHeight(currentStep);
    const observer = new ResizeObserver(() => updateStepsHeight(currentStep));
    const active = stepsSlotRef.current?.querySelector<HTMLElement>('.step-content.active');
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [currentStep, updateStepsHeight]);

  const goToStep = useCallback((step: number) => {
    if (step < 1 || step > totalSteps) return;
    const container = stepsContainerRef.current;
    container?.classList.add('steps-transitioning');
    setCurrentStep(step);
    setTimeout(() => container?.classList.remove('steps-transitioning'), 420);
  }, []);

  const handleConnect = useCallback(async () => {
    const key = apiKey.trim();
    setError(null);
    if (!key) return;

    setIsConnecting(true);

    try {
      const body: Record<string, string> = { apiKey: key };
      if (tenantId) body.tenantId = tenantId;
      const res = await apiFetch(`${apiBase}/api/connect/lemonsqueezy-finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }

      setIsConnected(true);
      setIsConnecting(false);

      confetti({
        particleCount: 80,
        spread: 60,
        origin: { y: 0.65 },
        colors: ['#FFD234', '#ffffff', '#22c55e', '#fde68a'],
      });
      setTimeout(() => {
        confetti({
          particleCount: 60,
          angle: 60,
          spread: 55,
          origin: { x: 0 },
          colors: ['#FFD234', '#fde68a'],
        });
        confetti({
          particleCount: 60,
          angle: 120,
          spread: 55,
          origin: { x: 1 },
          colors: ['#22c55e', '#ffffff'],
        });
      }, 200);

      setTimeout(() => goBackToDashboard(), 1600);
    } catch (err) {
      setIsConnecting(false);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [apiKey, tenantId, apiBase, goBackToDashboard]);

  const connectBtnClass = isConnected ? 'connect-btn success' : 'connect-btn ready';

  return (
    <div className="lemonsqueezy-setup">
      <BackgroundCanvasRoot position="absolute" />

      <div
        className={`page-content fixed inset-0 flex flex-col items-center justify-center overflow-y-auto overflow-x-hidden${isVisible ? ' is-visible' : ''}`}
      >
        {/* Back button */}
        {dashboardUrl && (
          <a
            href={dashboardUrl}
            className="fixed top-6 left-6 z-50 inline-flex items-center gap-2 px-4 py-2 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-all font-bold text-sm shadow-xl"
            style={{ textDecoration: 'none' }}
          >
            <ArrowLeft size={14} strokeWidth={2.5} />
            Dashboard
          </a>
        )}

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

          {/* Card */}
          <div className="card-shell w-full max-w-6xl max-h-[calc(100%-2rem)] p-5 sm:p-8 md:p-12 flex flex-col relative z-10 overflow-hidden bg-black/25 backdrop-blur-xl rounded-[40px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)]">
            {/* Top shine */}
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-2/3 pointer-events-none"
              style={{
                background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent)',
              }}
            />

            {/* Header */}
            <div
              className="flex flex-wrap justify-between items-end gap-4 mb-8 pb-5 flex-shrink-0"
              style={{
                borderBottom: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div>
                <div
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-[0.12em] mb-3"
                  style={{
                    background: 'rgba(255,210,52,0.1)',
                    border: '1px solid rgba(255,210,52,0.2)',
                    color: 'rgba(255,255,255,0.8)',
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#FFD234] animate-pulse" />
                  Integration Setup
                </div>
                <h1 className="text-3xl sm:text-4xl font-bold text-white leading-none tracking-tight">
                  Connect&nbsp;
                  <span style={{ color: '#FFD234' }}>Lemon&nbsp;Squeezy&reg;</span>
                </h1>
                <p className="mt-2 text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Webhook creation is handled automatically, just paste your API key.
                </p>
              </div>
              <div className="flex flex-col items-end gap-2.5">
                <span className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  Step {currentStep} of {totalSteps}
                </span>
                <div className="flex gap-1.5 items-center">
                  <div
                    className="step-dot"
                    data-index="1"
                    style={{
                      width: currentStep >= 1 ? '2rem' : '0.5rem',
                      background: currentStep >= 1 ? '#7c3aed' : 'rgba(255,255,255,0.1)',
                    }}
                  />
                  <div
                    className="step-dot"
                    data-index="2"
                    style={{
                      width: currentStep >= 2 ? '2rem' : '0.5rem',
                      background: currentStep >= 2 ? '#7c3aed' : 'rgba(255,255,255,0.1)',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Steps */}
            <div className="relative flex-shrink-0 steps-container" ref={stepsContainerRef}>
              <div className="steps-slot pr-1" ref={stepsSlotRef}>
                {/* Step 1 */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center${currentStep === 1 ? ' active' : ''}`}
                  data-step="1"
                >
                  {/* Mockup: LS Settings > API page */}
                  <div className="mockup-col">
                    <div className="mockup-shell">
                      <div className="traffic-lights">
                        <div className="tl tl-r" />
                        <div className="tl tl-y" />
                        <div className="tl tl-g" />
                      </div>
                      <div className="flex flex-1 min-h-0">
                        {/* Sidebar */}
                        <div className="ls-sidebar">
                          <div className="ls-logo-row">
                            <div className="ls-logo-mark" style={{ background: 'transparent' }}>
                              <img
                                src="/Icons/LemonSqueezy.png"
                                alt="Lemon Squeezy®"
                                style={{
                                  width: '22px',
                                  height: '22px',
                                  objectFit: 'contain',
                                }}
                              />
                            </div>
                            <div className="ls-logo-text">Lemon Squeezy&reg;</div>
                          </div>

                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <Home className="ls-nav-icon" />
                              <span>Home</span>
                            </div>
                          </div>
                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <Store className="ls-nav-icon" />
                              <span>Store</span>
                            </div>
                            <ChevronDown className="ls-nav-chevron" />
                          </div>
                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <Mail className="ls-nav-icon" />
                              <span>Email</span>
                            </div>
                            <ChevronDown className="ls-nav-chevron" />
                          </div>
                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <Users className="ls-nav-icon" />
                              <span>Affiliates</span>
                            </div>
                            <ChevronDown className="ls-nav-chevron" />
                          </div>
                          <div className="ls-nav-item">
                            <div
                              className="ls-nav-item-left border-l"
                              style={{
                                color: '#111827',
                                fontWeight: 600,
                              }}
                            >
                              <Settings className="ls-nav-icon" style={{ color: '#6366f1' }} />
                              <span>Settings</span>
                            </div>
                            <ChevronUp className="ls-nav-chevron" />
                          </div>

                          <div className="ls-subnav">
                            <div className="ls-subnav-item">General</div>
                            <div className="ls-subnav-item">Domains</div>
                            <div className="ls-subnav-item">Integrations</div>
                            <div className="ls-subnav-item">Webhooks</div>
                            <div className="ls-subnav-item">Email</div>
                            <div className="ls-subnav-item">Affiliates</div>
                            <div className="ls-subnav-item">Stores</div>
                            <div className="ls-subnav-item active">API</div>
                          </div>

                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <PenTool className="ls-nav-icon" />
                              <span>Design</span>
                            </div>
                            <ChevronRight className="ls-nav-chevron" />
                          </div>
                          <div className="ls-nav-item">
                            <div className="ls-nav-item-left">
                              <Sliders className="ls-nav-icon" />
                              <span>Setup</span>
                            </div>
                            <ChevronRight className="ls-nav-chevron" />
                          </div>
                        </div>

                        {/* Main area */}
                        <div className="ls-main">
                          <div className="ls-page-title">Settings</div>

                          <div className="ls-tabs">
                            <div className="ls-tab">General</div>
                            <div className="ls-tab">Domains</div>
                            <div className="ls-tab">Integrations</div>
                            <div className="ls-tab">Webhooks</div>
                            <div className="ls-tab">Email</div>
                            <div className="ls-tab pt-1" style={{ flex: 1 }} />
                            <div className="ls-tab">Stores</div>
                            <div className="ls-tab active">API</div>
                          </div>

                          <div className="ls-api-highlight-zone">
                            <div className="ls-section-header">
                              <div>
                                <div className="ls-section-title">API keys</div>
                                <div className="ls-section-desc">
                                  Create a new API key to authenticate your app &middot;{' '}
                                  <span
                                    style={{
                                      color: '#7c3aed',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Help &#8599;
                                  </span>
                                </div>
                              </div>
                              <div className="ls-new-btn">
                                <Plus
                                  style={{
                                    width: '18px',
                                    height: '18px',
                                  }}
                                />
                              </div>
                            </div>

                            <div className="ls-keys-table">
                              <div className="ls-empty-row">No API keys yet</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Instructions */}
                  <div className="instructions-col">
                    <div className="p-8 rounded-3xl bg-black/25 backdrop-blur-xl">
                      <div className="space-y-7">
                        <div>
                          <h2 className="text-3xl sm:text-4xl font-extrabold text-white leading-tight tracking-tight">
                            Open your API
                            <br />
                            Settings
                          </h2>
                          <div
                            className="mt-3 w-10 h-[3px] rounded-full"
                            style={{ background: '#8b5cf6' }}
                          />
                        </div>

                        <p
                          style={{
                            color: 'rgba(255,255,255,0.65)',
                            fontSize: '16px',
                            lineHeight: '1.7',
                          }}
                        >
                          Head to <strong style={{ color: '#fff' }}>Settings &rarr; API</strong> in
                          your Lemon&nbsp;Squeezy&reg; dashboard. That&apos;s where you&apos;ll
                          create the API key we need.
                        </p>

                        <div className="flex flex-wrap gap-2">
                          <div className="feature-pill">
                            <div className="feature-pill-dot" />
                            Webhooks created automatically
                          </div>
                          <div className="feature-pill">
                            <div className="feature-pill-dot" />
                            Encrypted &amp; stored securely
                          </div>
                        </div>

                        <a
                          href="https://app.lemonsqueezy.com/settings/api"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ls-open-btn w-full sm:w-auto"
                        >
                          <ExternalLink size={16} strokeWidth={2.5} />
                          Open Lemon Squeezy&reg; API
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Step 2 */}
                <div
                  className={`step-content grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center${currentStep === 2 ? ' active' : ''}`}
                  data-step="2"
                >
                  {/* Mockup: key creation modal + revealed key */}
                  <div className="mockup-col">
                    <div className="mockup-shell">
                      <div className="traffic-lights">
                        <div className="tl tl-r" />
                        <div className="tl tl-y" />
                        <div className="tl tl-g" />
                      </div>
                      {/* Blurred background page */}
                      <div
                        className="absolute inset-0 flex opacity-[0.85] pointer-events-none"
                        style={{ filter: 'blur(3px)' }}
                      >
                        <div className="ls-sidebar" style={{ paddingTop: '36px' }}>
                          <div className="ls-logo-row">
                            <div className="ls-logo-mark" style={{ background: 'transparent' }}>
                              <img
                                src="/Icons/LemonSqueezy.png"
                                alt="Lemon Squeezy®"
                                style={{
                                  width: '22px',
                                  height: '22px',
                                  objectFit: 'contain',
                                }}
                              />
                            </div>
                          </div>
                          <div className="ls-nav-item active" style={{ marginTop: '40px' }}>
                            <div className="ls-nav-item-left">
                              <Settings className="ls-nav-icon" style={{ color: '#6366f1' }} />
                              <span>Settings</span>
                            </div>
                          </div>
                        </div>
                        <div className="ls-main">
                          <div className="ls-page-title">Settings</div>
                          <div className="ls-tabs">
                            <div className="ls-tab">General</div>
                            <div className="ls-tab pt-1" style={{ flex: 1 }} />
                            <div className="ls-tab active">API</div>
                          </div>
                        </div>
                      </div>
                      {/* Modal overlay */}
                      <div className="ls-modal-overlay">
                        <div className="ls-modal">
                          <div className="ls-modal-header">
                            New API key
                            <span className="ls-modal-close">&#10005;</span>
                          </div>
                          <div className="ls-modal-body">
                            <div>
                              <div className="ls-field-label">Name</div>
                              <div className="ls-field-input highlighted">Creator Assistant</div>
                            </div>
                            {/* Revealed key */}
                            <div>
                              <div className="ls-field-label" style={{ marginBottom: '6px' }}>
                                Your API key, copy it now
                              </div>
                              <div className="ls-revealed-key">
                                <span className="ls-key-icon">&#128273;</span>
                                <span className="ls-key-text">
                                  eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQ...
                                </span>
                                <span className="ls-copy-chip">COPY</span>
                              </div>
                            </div>
                          </div>
                          <div className="ls-modal-footer">
                            <div className="ls-btn-cancel">Cancel</div>
                            <div className="ls-btn-create">Create API key</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Instructions + input */}
                  <div className="instructions-col">
                    <div className="p-8 rounded-3xl bg-black/25 backdrop-blur-xl">
                      <div className="space-y-6">
                        <div>
                          <h2 className="text-3xl sm:text-4xl font-extrabold text-white leading-tight tracking-tight">
                            Paste your
                            <br />
                            API Key
                          </h2>
                          <div
                            className="mt-3 w-10 h-[3px] rounded-full"
                            style={{ background: '#8b5cf6' }}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <p
                            style={{
                              color: 'rgba(255,255,255,0.55)',
                              fontSize: '14px',
                              lineHeight: '1.6',
                            }}
                          >
                            Click <strong style={{ color: '#fff' }}>+</strong> on the API page, give
                            it any name (e.g. <em>Creator Assistant</em>), then click{' '}
                            <strong style={{ color: '#fff' }}>Create API key</strong>. Copy the key
                            shown, it&apos;s only revealed once.
                          </p>
                        </div>

                        <div className="space-y-3">
                          <label
                            className="block text-xs font-bold uppercase tracking-widest"
                            style={{
                              color: 'rgba(255,255,255,0.4)',
                            }}
                          >
                            API Key
                          </label>
                          <div style={{ position: 'relative' }}>
                            <input
                              type={showKey ? 'text' : 'password'}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="eyJ0eXAiOiJKV1Qi..."
                              className="api-key-input"
                              value={apiKey}
                              onChange={(e) => setApiKey(e.target.value)}
                            />
                            <button
                              type="button"
                              title="Show/hide key"
                              onClick={() => setShowKey((p) => !p)}
                              style={{
                                position: 'absolute',
                                right: '12px',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'rgba(255,255,255,0.3)',
                                padding: '4px',
                                transition: 'color 0.15s ease',
                              }}
                              onMouseOver={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.color =
                                  'rgba(255,255,255,0.7)';
                              }}
                              onMouseOut={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.color =
                                  'rgba(255,255,255,0.3)';
                              }}
                            >
                              {showKey ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>

                        {error && <div className="error-box">{error}</div>}

                        <button
                          type="button"
                          className={connectBtnClass}
                          disabled={apiKey.trim().length < 10 || isConnecting || isConnected}
                          onClick={handleConnect}
                          style={
                            isConnecting
                              ? {
                                  background: 'rgba(255,210,52,0.6)',
                                  transform: 'none',
                                  boxShadow: 'none',
                                }
                              : undefined
                          }
                        >
                          <span>
                            {isConnected
                              ? 'Connected!'
                              : isConnecting
                                ? 'Connecting...'
                                : 'Connect Lemon Squeezy'}
                          </span>
                          {isConnecting && <div className="btn-spinner" />}
                          {isConnected && (
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>

                        <p
                          style={{
                            color: 'rgba(255,255,255,0.25)',
                            fontSize: '12px',
                            lineHeight: '1.5',
                          }}
                        >
                          We&apos;ll automatically set up webhooks in your Lemon Squeezy store. Your
                          key is encrypted before storage.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Nav buttons */}
            <div
              className="mt-auto pt-8 pb-2 flex flex-col-reverse sm:flex-row justify-between items-stretch sm:items-center gap-4 flex-shrink-0 relative z-20"
              style={{
                borderTop: '1px solid rgba(255,255,255,0.05)',
                marginTop: '1.5rem',
              }}
            >
              <button
                type="button"
                disabled={currentStep === 1}
                className="px-6 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 min-h-[44px] transition-all"
                style={{
                  color: 'rgba(255,255,255,0.5)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  opacity: currentStep === 1 ? 0.3 : 1,
                  pointerEvents: currentStep === 1 ? 'none' : 'auto',
                }}
                onMouseOver={(e) => {
                  if (currentStep > 1) {
                    (e.currentTarget as HTMLButtonElement).style.color = 'white';
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.05)';
                  }
                }}
                onMouseOut={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
                onClick={() => goToStep(currentStep - 1)}
              >
                <ArrowLeft size={16} strokeWidth={2} />
                Back
              </button>
              {currentStep < totalSteps && (
                <button
                  type="button"
                  className="px-8 py-3 rounded-2xl font-bold text-[15px] flex items-center justify-center gap-2 min-h-[44px] transition-all group"
                  style={{
                    background: 'linear-gradient(180deg, #8b5cf6 0%, #7c3aed 100%)',
                    color: '#ffffff',
                    border: '1px solid rgba(124,58,237,0.5)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.1)',
                  }}
                  onMouseEnter={(e) => {
                    const btn = e.currentTarget as HTMLButtonElement;
                    const arrow = btn.querySelector<SVGElement>('.next-arrow');
                    if (arrow) arrow.style.transform = 'translateX(3px)';
                    btn.style.transform = 'translateY(-1px)';
                    btn.style.boxShadow =
                      '0 8px 30px rgba(124,58,237,0.35), inset 0 1px 0 rgba(255,255,255,0.1)';
                  }}
                  onMouseLeave={(e) => {
                    const btn = e.currentTarget as HTMLButtonElement;
                    const arrow = btn.querySelector<SVGElement>('.next-arrow');
                    if (arrow) arrow.style.transform = 'translateX(0)';
                    btn.style.transform = '';
                    btn.style.boxShadow =
                      '0 1px 2px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.1)';
                  }}
                  onClick={() => goToStep(currentStep + 1)}
                >
                  Next
                  <ArrowRight
                    size={16}
                    strokeWidth={2.5}
                    className="next-arrow"
                    style={{ transition: 'transform 0.2s ease' }}
                  />
                </button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
