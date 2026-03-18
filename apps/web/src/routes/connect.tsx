import { createFileRoute, useNavigate } from '@tanstack/react-router';
import confetti from 'canvas-confetti';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiClient } from '@/api/client';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/connect')({
  validateSearch: (search: Record<string, unknown>) => ({
    guild_id: typeof search.guild_id === 'string' ? search.guild_id : undefined,
    guildId: typeof search.guildId === 'string' ? search.guildId : undefined,
    tenant_id: typeof search.tenant_id === 'string' ? search.tenant_id : undefined,
    tenantId: typeof search.tenantId === 'string' ? search.tenantId : undefined,
    setup_token: typeof search.setup_token === 'string' ? search.setup_token : undefined,
    connect_token: typeof search.connect_token === 'string' ? search.connect_token : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Connect Accounts | Creator Assistant' }],
    links: [
      {
        rel: 'stylesheet',
        href: 'https://db.onlinewebfonts.com/c/5cae74f63bd48d24d5abdddb3af09a50?family=Airbnb+Cereal+App+Black',
      },
      ...routeStylesheetLinks(routeStyleHrefs.connect),
    ],
  }),
  component: ConnectPage,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Connection {
  id: string;
  provider: string;
  status: string;
}

interface ConnectionsResponse {
  connections?: Connection[];
  allowMismatchedEmails?: boolean;
  gumroad?: boolean;
  jinxxy?: boolean;
  vrchat?: boolean;
}

interface ConnectSearch {
  guild_id: string | undefined;
  guildId: string | undefined;
  tenant_id: string | undefined;
  tenantId: string | undefined;
  setup_token: string | undefined;
  connect_token: string | undefined;
}

interface CompleteResponse {
  success: boolean;
  tenantId?: string;
  isFirstTime?: boolean;
  error?: string;
}

type ModalState =
  | { type: 'closed' }
  | { type: 'alert'; message: string; resolve: () => void }
  | {
      type: 'confirm';
      message: string;
      resolve: (result: boolean) => void;
    };

interface PlatformDef {
  key: string;
  label: string;
  subtitle: string;
  icon: string;
  bgClass: string;
  shadowClass: string;
  connectedBgClass: string;
  connectedShadowClass: string;
  confettiColors: string[];
  connectRedirect: (tenantId: string | null, guildId: string | null) => string;
}

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------

const PLATFORMS: PlatformDef[] = [
  {
    key: 'gumroad',
    label: 'Gumroad\u00AE',
    subtitle: 'Creator Store',
    icon: './Icons/Gumorad.png',
    bgClass: 'bg-[rgba(255,144,232,0.9)]',
    shadowClass: 'shadow-[#ff90e8]/30',
    connectedBgClass: 'bg-[#e269c9]',
    connectedShadowClass: 'shadow-[#e269c9]/20',
    confettiColors: ['#ff90e8', '#36a9ae', '#ffffff'],
    connectRedirect: (tid, gid) =>
      tid && gid
        ? `/api/connect/gumroad/begin?tenantId=${encodeURIComponent(tid)}&guildId=${encodeURIComponent(gid)}`
        : '/api/connect/gumroad/begin',
  },
  {
    key: 'jinxxy',
    label: 'Jinxxy\u2122',
    subtitle: 'Marketplace',
    icon: './Icons/Jinxxy\u2122.png',
    bgClass: 'bg-[rgba(145,70,255,0.9)]',
    shadowClass: 'shadow-[#9146FF]/30',
    connectedBgClass: 'bg-[#7b3be6]',
    connectedShadowClass: 'shadow-[#7b3be6]/20',
    confettiColors: ['#9146FF', '#ffffff'],
    connectRedirect: (tid, gid) =>
      tid && gid
        ? `/setup/jinxxy?tenantId=${encodeURIComponent(tid)}&guildId=${encodeURIComponent(gid)}`
        : '/setup/jinxxy',
  },
  {
    key: 'vrchat',
    label: 'VRChat\u00AE',
    subtitle: 'Store',
    icon: './Icons/VRC.png',
    bgClass: 'bg-[rgba(0,180,140,0.9)]',
    shadowClass: 'shadow-[#00b48c]/30',
    connectedBgClass: 'bg-[#009b70]',
    connectedShadowClass: 'shadow-[#009b70]/20',
    confettiColors: ['#00b48c', '#ffffff'],
    connectRedirect: () => '#',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redirectToExpiredLinkError() {
  if (typeof window === 'undefined') return;
  const errorUrl = new URL('/verify-error', window.location.origin);
  errorUrl.searchParams.set('error', 'link_expired');
  window.location.replace(errorUrl.toString());
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ConnectPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const guildIdParam = search.guild_id || search.guildId || '';
  const tenantIdParam = search.tenant_id || search.tenantId || null;
  const bootstrapSetupToken = search.setup_token || null;
  const bootstrapConnectToken = search.connect_token || null;

  // -- State ----------------------------------------------------------------
  const [connectionsMap, setConnectionsMap] = useState<Map<string, Connection>>(() => new Map());
  const [tenantId, setTenantId] = useState<string | null>(tenantIdParam);
  const [modalState, setModalState] = useState<ModalState>({ type: 'closed' });
  const [pageVisible, setPageVisible] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [statusClass, setStatusClass] = useState('text-center text-sm font-bold text-[#7a7a9f]');
  const [statusVisible, setStatusVisible] = useState(false);
  const [doneDisabled, setDoneDisabled] = useState(false);
  const [doneLabel, setDoneLabel] = useState('Continue in Discord\u00AE');
  const [doneHidden, setDoneHidden] = useState(false);
  const [postSetupVisible, setPostSetupVisible] = useState(false);
  const [firstTimeHint, setFirstTimeHint] = useState('');
  const [dashboardHref, setDashboardHref] = useState('#');
  const [allowMismatchedEmails, setAllowMismatchedEmails] = useState(false);
  const [hoveredPlatform, setHoveredPlatform] = useState<string | null>(null);

  // -- Refs -----------------------------------------------------------------
  const cursorDotRef = useRef<HTMLDivElement>(null);
  const cursorOutlineRef = useRef<HTMLDivElement>(null);
  const guildIdRef = useRef(guildIdParam);
  const tenantIdRef = useRef(tenantIdParam);
  const connectionsMapRef = useRef(connectionsMap);
  const hasSetupSessionRef = useRef(false);
  const bootstrappedTokenRef = useRef<string | null>(null);

  // Keep refs in sync
  tenantIdRef.current = tenantIdParam ?? tenantId;
  connectionsMapRef.current = connectionsMap;

  // -- Modal helpers --------------------------------------------------------
  const showAlert = useCallback(
    (message: string) =>
      new Promise<void>((resolve) => {
        setModalState({ type: 'alert', message, resolve });
      }),
    []
  );

  const showConfirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setModalState({ type: 'confirm', message, resolve });
      }),
    []
  );

  const closeModal = useCallback(
    (result?: boolean) => {
      if (modalState.type === 'alert') {
        modalState.resolve();
      } else if (modalState.type === 'confirm') {
        modalState.resolve(result ?? false);
      }
      setModalState({ type: 'closed' });
    },
    [modalState]
  );

  // -- Update platform cards from status ------------------------------------
  const _applyStatus = useCallback(
    (status: { gumroad?: boolean; jinxxy?: boolean; vrchat?: boolean }) => {
      // nothing extra needed; connectionsMap drives the UI
      void status;
    },
    []
  );

  // -- Fetch connections & tenant -------------------------------------------
  const ensureTenantAndStatus = useCallback(async () => {
    try {
      let statusData: ConnectionsResponse | null = null;

      if (hasSetupSessionRef.current) {
        statusData = await apiClient.get<ConnectionsResponse>('/api/connections');
      } else if (tenantIdRef.current) {
        statusData = await apiClient.get<ConnectionsResponse>('/api/connect/status', {
          params: { tenantId: tenantIdRef.current },
        });
      } else {
        const data = await apiClient.get<{ tenantId?: string }>('/api/connect/ensure-tenant', {
          params: { guildId: guildIdRef.current },
        });
        if (data.tenantId) {
          setTenantId(data.tenantId);
          tenantIdRef.current = data.tenantId;
          statusData = await apiClient.get<ConnectionsResponse>('/api/connect/status', {
            params: { tenantId: data.tenantId },
          });
        } else {
          setStatusText('Error: Could not resolve or create tenant.');
          setStatusClass('text-center text-sm font-bold text-red-600');
          setStatusVisible(true);
          return;
        }
      }

      if (!statusData) return;

      if (statusData.connections) {
        const newMap = new Map<string, Connection>();
        for (const c of statusData.connections) {
          if (c.status === 'active') {
            newMap.set(c.provider, c);
          }
        }
        setConnectionsMap(newMap);
        connectionsMapRef.current = newMap;

        if (statusData.allowMismatchedEmails !== undefined) {
          setAllowMismatchedEmails(!!statusData.allowMismatchedEmails);
        }
      } else {
        // Legacy format
        const newMap = new Map<string, Connection>();
        if (statusData.gumroad)
          newMap.set('gumroad', {
            id: 'gumroad',
            provider: 'gumroad',
            status: 'active',
          });
        if (statusData.jinxxy)
          newMap.set('jinxxy', {
            id: 'jinxxy',
            provider: 'jinxxy',
            status: 'active',
          });
        if (statusData.vrchat)
          newMap.set('vrchat', {
            id: 'vrchat',
            provider: 'vrchat',
            status: 'active',
          });
        setConnectionsMap(newMap);
        connectionsMapRef.current = newMap;
      }
    } catch (err) {
      console.error('Error setting up:', err);
    }
  }, []);

  // -- Bootstrap token exchange ---------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const legacySetupToken = hash.get('s');
      const legacyConnectToken = hash.get('token');

      if (
        (legacySetupToken || legacyConnectToken) &&
        !bootstrapSetupToken &&
        !bootstrapConnectToken
      ) {
        const nextSearch: ConnectSearch = {
          guild_id: guildIdParam || undefined,
          guildId: search.guildId,
          tenant_id: tenantIdParam ?? undefined,
          tenantId: search.tenantId,
          setup_token: legacySetupToken || undefined,
          connect_token: legacyConnectToken || undefined,
        };
        navigate({
          to: '/connect',
          search: nextSearch,
          hash: '',
          replace: true,
        });
        return;
      }

      const bootstrapToken = bootstrapSetupToken || bootstrapConnectToken;
      if (bootstrapToken && bootstrappedTokenRef.current !== bootstrapToken) {
        bootstrappedTokenRef.current = bootstrapToken;
        try {
          const response = await fetch('/api/connect/bootstrap', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              setupToken: bootstrapSetupToken || undefined,
              connectToken: bootstrapConnectToken || undefined,
            }),
          });
          if (!response.ok) {
            redirectToExpiredLinkError();
            return;
          }

          hasSetupSessionRef.current = true;
          navigate({
            to: '/connect',
            search: {
              guild_id: guildIdParam || undefined,
              guildId: search.guildId,
              tenant_id: tenantIdParam ?? undefined,
              tenantId: search.tenantId,
              setup_token: undefined,
              connect_token: undefined,
            },
            hash: '',
            replace: true,
          });
        } catch {
          redirectToExpiredLinkError();
          return;
        }
      }

      if (!guildIdRef.current && !tenantIdRef.current && !hasSetupSessionRef.current) {
        redirectToExpiredLinkError();
        return;
      }

      if (!cancelled) {
        setPageVisible(true);
        await ensureTenantAndStatus();
      }

      // Handle ?gumroad=connected query param
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('gumroad') === 'connected') {
        const cleanUrl = guildIdRef.current
          ? `${window.location.pathname}?guild_id=${encodeURIComponent(guildIdRef.current)}`
          : window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        setTimeout(() => {
          if (!cancelled) ensureTenantAndStatus();
        }, 500);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [
    bootstrapConnectToken,
    bootstrapSetupToken,
    ensureTenantAndStatus,
    guildIdParam,
    navigate,
    search.guildId,
    search.tenantId,
    tenantIdParam,
  ]);

  // -- Custom cursor --------------------------------------------------------
  useEffect(() => {
    const dot = cursorDotRef.current;
    const outline = cursorOutlineRef.current;
    if (!dot || !outline) return;

    const handleMouseMove = (e: MouseEvent) => {
      const posX = e.clientX;
      const posY = e.clientY;
      dot.style.left = `${posX}px`;
      dot.style.top = `${posY}px`;
      outline.animate({ left: `${posX}px`, top: `${posY}px` }, { duration: 500, fill: 'forwards' });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // -- Cursor expand on hover over buttons/links ---------------------------
  useEffect(() => {
    const outline = cursorOutlineRef.current;
    if (!outline) return;

    const handleEnter = () => {
      outline.style.width = '60px';
      outline.style.height = '60px';
      outline.style.backgroundColor = 'rgba(240, 204, 96, 0.1)';
    };
    const handleLeave = () => {
      outline.style.width = '40px';
      outline.style.height = '40px';
      outline.style.backgroundColor = 'transparent';
    };

    const els = document.querySelectorAll('button, a');
    els.forEach((el) => {
      el.addEventListener('mouseenter', handleEnter);
      el.addEventListener('mouseleave', handleLeave);
    });

    return () => {
      els.forEach((el) => {
        el.removeEventListener('mouseenter', handleEnter);
        el.removeEventListener('mouseleave', handleLeave);
      });
    };
  }, []);

  // -- Keyboard handler for modal -------------------------------------------
  useEffect(() => {
    if (modalState.type === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalState, closeModal]);

  // -- Platform click handler -----------------------------------------------
  const handlePlatformClick = useCallback(
    async (platform: PlatformDef, buttonEl: HTMLButtonElement) => {
      if (platform.key === 'discord') return;

      const tid = tenantIdRef.current;
      if (!tid && !hasSetupSessionRef.current) {
        await showAlert('Please wait for the page to load.');
        return;
      }

      const isConnected = connectionsMapRef.current.has(platform.key);

      // Disconnect flow
      if (isConnected) {
        const confirmed = await showConfirm(
          `Are you sure you want to disconnect ${platform.label}?`
        );
        if (!confirmed) return;

        const conn = connectionsMapRef.current.get(platform.key);
        if (!conn) return;

        try {
          const params: Record<string, string> = { id: conn.id };
          if (tid) params.authUserId = tid;
          await apiClient.delete('/api/connections', { params });

          setConnectionsMap((prev) => {
            const next = new Map(prev);
            next.delete(platform.key);
            return next;
          });
        } catch (err) {
          if (err instanceof ApiError) {
            const body = err.body as { error?: string } | null;
            await showAlert(body?.error || 'Failed to disconnect');
          } else {
            await showAlert('Could not disconnect that account right now. Please try again.');
          }
        }
        return;
      }

      // Connect flow - fire confetti from button position
      const rect = buttonEl.getBoundingClientRect();
      confetti({
        particleCount: 40,
        spread: 60,
        origin: {
          x: (rect.left + rect.width / 2) / window.innerWidth,
          y: (rect.top + rect.height / 2) / window.innerHeight,
        },
        colors: platform.confettiColors,
        ticks: 200,
      });

      setTimeout(() => {
        window.location.href = platform.connectRedirect(tid, guildIdRef.current || null);
      }, 400);
    },
    [showAlert, showConfirm]
  );

  // -- Done button handler --------------------------------------------------
  const handleDoneClick = useCallback(async () => {
    setDoneDisabled(true);
    setDoneLabel('Completing...');
    setStatusVisible(true);
    setStatusText('');
    setStatusClass('text-center text-sm font-bold text-[#7a7a9f]');

    try {
      const data = await apiClient.post<CompleteResponse>('/api/connect/complete', {
        guildId: guildIdRef.current,
      });

      if (data.success) {
        setStatusText('Setup complete! You can close this window and continue in Discord\u00AE.');
        setStatusClass('text-center text-sm font-bold text-green-600');

        // Confetti burst
        const end = Date.now() + 1500;
        (function frame() {
          confetti({
            particleCount: 4,
            angle: 60,
            spread: 55,
            origin: { x: 0 },
            colors: ['#d45d39', '#224285', '#f0cc60'],
          });
          confetti({
            particleCount: 4,
            angle: 120,
            spread: 55,
            origin: { x: 1 },
            colors: ['#d45d39', '#224285', '#f0cc60'],
          });
          if (Date.now() < end) requestAnimationFrame(frame);
        })();

        setDoneHidden(true);

        if (data.tenantId) {
          setTenantId(data.tenantId);
          tenantIdRef.current = data.tenantId;
        }

        if (data.isFirstTime) {
          setFirstTimeHint(
            'Next step: Run /creator-admin autosetup in Discord\u00AE to create roles and the verify button.'
          );
        }

        const dashUrl = new URL('/dashboard', window.location.origin);
        const tid = data.tenantId || tenantIdRef.current;
        if (tid) dashUrl.searchParams.set('tenant_id', tid);
        if (guildIdRef.current) dashUrl.searchParams.set('guild_id', guildIdRef.current);
        setDashboardHref(dashUrl.toString());

        setPostSetupVisible(true);
      } else {
        setStatusText(data.error || 'Something went wrong.');
        setStatusClass('text-center text-sm font-bold text-red-600');
        setDoneDisabled(false);
        setDoneLabel('Done - Continue Setup in Discord\u00AE');
      }
    } catch {
      setStatusText('Network error. Please try again.');
      setStatusClass('text-center text-sm font-bold text-red-600');
      setDoneDisabled(false);
      setDoneLabel('Done - Continue Setup in Discord\u00AE');
    }
  }, []);

  // -- Toggle mismatched emails ---------------------------------------------
  const toggleMismatchedEmails = useCallback(async () => {
    const newValue = !allowMismatchedEmails;
    setAllowMismatchedEmails(newValue);

    try {
      await apiClient.post('/api/connect/settings', {
        key: 'allowMismatchedEmails',
        value: newValue,
        authUserId: tenantIdRef.current || undefined,
      });
    } catch {
      await showAlert('Could not save that setting right now. Please try again.');
      setAllowMismatchedEmails(!newValue); // Revert
    }
  }, [allowMismatchedEmails, showAlert]);

  // -- Return to Discord handler --------------------------------------------
  const handleReturnToDiscord = useCallback(() => {
    window.close();
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="connect-page min-h-screen flex flex-col selection:bg-yellow-200 bg-gradient-to-b from-[#0a3d9e] to-[#0ea5e9] text-white">
      {/* Liquid glass modal (alert/confirm) */}
      <div
        id="modal-backdrop"
        className={`modal-backdrop${modalState.type !== 'closed' ? ' is-visible' : ''}`}
        aria-hidden={modalState.type === 'closed' ? 'true' : 'false'}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal(false);
        }}
      >
        <div
          className="modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-message"
        >
          <p id="modal-message" className="modal-message">
            {modalState.type !== 'closed' ? modalState.message : ''}
          </p>
          <div className="modal-actions" id="modal-actions">
            {modalState.type === 'alert' && (
              <button
                type="button"
                className="modal-btn modal-btn-primary"
                onClick={() => closeModal()}
              >
                OK
              </button>
            )}
            {modalState.type === 'confirm' && (
              <>
                <button
                  type="button"
                  className="modal-btn modal-btn-secondary"
                  onClick={() => closeModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  onClick={() => closeModal(true)}
                >
                  Confirm
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div
        id="page-content"
        className={pageVisible ? 'is-visible' : ''}
        style={pageVisible ? undefined : { display: 'none' }}
      >
        <BackgroundCanvasRoot />

        <div className="cursor-dot" ref={cursorDotRef} />
        <div className="cursor-dot-outline" ref={cursorOutlineRef} />

        <main className="flex-grow flex flex-col items-center justify-center px-4 py-8 relative min-h-screen">
          <div className="max-w-xl w-full connect-card glass-card rounded-[32px] p-5 sm:p-7 md:p-10 relative z-10 reveal text-white shadow-2xl">
            {/* Header section */}
            <div className="flex flex-col items-center text-center mb-8 relative">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#ffffff]/10 text-[#ffffff] rounded-full text-[10px] font-black uppercase tracking-widest mb-4 backdrop-blur-md border border-white/20 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-[#0ea5e9] animate-pulse" />
                Sync Progress
              </div>
              <h1
                className="text-3xl sm:text-4xl md:text-5xl font-black text-[#ffffff] mb-3 relative tracking-tight leading-tight"
                style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
              >
                Connect Your
                <br />
                <span className="bg-gradient-to-r from-[#0ea5e9] to-[#0ea5e9] bg-clip-text text-transparent filter drop-shadow-[0_0_15px_rgba(14,165,233,0.3)]">
                  Accounts
                </span>
              </h1>
              <p
                className="text-[rgba(255,255,255,0.85)] font-medium leading-relaxed max-w-sm mx-auto text-base mt-2"
                style={{ fontFamily: "'DM Sans', sans-serif" }}
              >
                Link your platforms to unlock custom roles, tiered rewards, and seamless profile
                sync.
              </p>
            </div>

            {/* Platform buttons */}
            <div className="space-y-3 relative z-10">
              {/* Discord button (always connected, not clickable) */}
              <button
                type="button"
                className="w-full flex items-center justify-between p-4 rounded-3xl bg-[rgba(88,101,242,0.9)] backdrop-blur-md text-white shadow-xl shadow-[#5865F2]/30 opacity-95 cursor-default border border-white/20 transition-transform hover:scale-[1.02]"
                data-platform="discord"
              >
                <div className="flex items-center gap-3 sm:gap-5">
                  <img
                    className="w-10 h-10 sm:w-12 sm:h-12 drop-shadow-lg"
                    src="Icons/Discord\u00AE.png"
                    alt="Discord\u00AE"
                  />
                  <div className="text-left flex flex-col justify-center">
                    <span
                      className="font-bold tracking-tight text-xl block text-white"
                      style={{
                        fontFamily: "'Plus Jakarta Sans', sans-serif",
                      }}
                    >
                      Discord&reg;
                    </span>
                    <span
                      className="text-sm opacity-80 text-white leading-none"
                      style={{ fontFamily: "'DM Sans', sans-serif" }}
                    >
                      Identity Provider
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-white/20 px-4 py-1.5 rounded-full flex-shrink-0">
                  <div className="w-2 h-2 rounded-full bg-[#00e676] shadow-[0_0_8px_#00e676]" />
                  <span
                    className="text-xs font-black uppercase tracking-widest text-white translate-y-[1px]"
                    style={{
                      fontFamily: "'Plus Jakarta Sans', sans-serif",
                    }}
                  >
                    Connected
                  </span>
                </div>
              </button>

              {/* Dynamic platform buttons */}
              {PLATFORMS.map((platform) => {
                const isConnected = connectionsMap.has(platform.key);
                const isHoverDisconnect = isConnected && hoveredPlatform === platform.key;

                const bgClass = isHoverDisconnect
                  ? 'bg-red-500'
                  : isConnected
                    ? platform.connectedBgClass
                    : platform.bgClass;

                const shadowClass = isHoverDisconnect
                  ? 'shadow-red-500/20'
                  : isConnected
                    ? platform.connectedShadowClass
                    : platform.shadowClass;

                const badgeBgClass =
                  platform.key === 'gumroad' && !isConnected
                    ? 'bg-black/10 group-hover:bg-black/20'
                    : 'bg-white/20 group-hover:bg-white/30';

                return (
                  <button
                    key={platform.key}
                    type="button"
                    className={`platform-btn w-full flex items-center justify-between p-4 rounded-3xl ${bgClass} backdrop-blur-md text-white shadow-xl ${shadowClass} group border border-white/20`}
                    data-platform={platform.key}
                    data-connected={isConnected ? 'true' : 'false'}
                    onMouseEnter={() => {
                      if (isConnected) setHoveredPlatform(platform.key);
                    }}
                    onMouseLeave={() => {
                      if (isConnected) setHoveredPlatform(null);
                    }}
                    onClick={(e) =>
                      handlePlatformClick(platform, e.currentTarget as HTMLButtonElement)
                    }
                  >
                    <div className="flex items-center gap-3 sm:gap-5">
                      <img
                        className="w-10 h-10 sm:w-12 sm:h-12 drop-shadow-lg"
                        src={platform.icon}
                        alt={platform.label}
                      />
                      <div className="text-left flex flex-col justify-center">
                        <span
                          className="font-bold tracking-tight text-xl block text-white"
                          style={{
                            fontFamily: "'Plus Jakarta Sans', sans-serif",
                          }}
                        >
                          {platform.label}
                        </span>
                        <span
                          className={`text-sm opacity-80 font-medium text-white leading-none`}
                          style={{
                            fontFamily: "'DM Sans', sans-serif",
                          }}
                        >
                          {platform.subtitle}
                        </span>
                      </div>
                    </div>

                    {/* Badge */}
                    <div
                      className={`flex items-center gap-2 text-white px-4 py-2 rounded-full backdrop-blur-md transition-colors flex-shrink-0 ${isConnected ? 'bg-white/20' : badgeBgClass}`}
                    >
                      {isConnected ? (
                        <>
                          <span
                            className="connect-badge text-xs font-bold uppercase transition-all duration-200"
                            style={{
                              fontFamily: "'Plus Jakarta Sans', sans-serif",
                            }}
                          >
                            {isHoverDisconnect ? 'Disconnect' : 'Connected'}
                          </span>
                          {isHoverDisconnect ? (
                            <svg
                              className="w-5 h-5 transition-transform"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              strokeWidth="3"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          ) : (
                            <svg
                              className="w-5 h-5 transition-transform"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          )}
                        </>
                      ) : (
                        <>
                          <span
                            className="connect-badge text-xs font-black uppercase tracking-widest text-white translate-y-[1px]"
                            style={{
                              fontFamily: "'Plus Jakarta Sans', sans-serif",
                            }}
                          >
                            Connect
                          </span>
                          <svg
                            className="w-4 h-4 transition-transform group-hover:translate-x-1 text-white"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            viewBox="0 0 24 24"
                          >
                            <path d="M5 12h14M12 5l7 7-7 7" />
                          </svg>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Settings Section */}
            <div className="mt-6 pt-5 border-t border-[rgba(255,255,255,0.1)]/60 relative z-10">
              <div className="flex items-center justify-between bg-white/5 p-4 rounded-2xl border border-white/10 hover:bg-white/10 transition-colors">
                <div>
                  <h3
                    className="text-sm font-bold text-[#ffffff]"
                    style={{
                      fontFamily: "'Plus Jakarta Sans', sans-serif",
                    }}
                  >
                    Allow Mismatched Emails
                  </h3>
                  <p
                    className="text-xs text-[rgba(255,255,255,0.7)] mt-1"
                    style={{ fontFamily: "'DM Sans', sans-serif" }}
                  >
                    Buyers can verify with different emails.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-4">
                  <input
                    type="checkbox"
                    id="mismatched-emails-toggle"
                    className="sr-only peer"
                    checked={allowMismatchedEmails}
                    onChange={toggleMismatchedEmails}
                  />
                  <div className="w-11 h-6 bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0ea5e9]" />
                </label>
              </div>
            </div>

            {/* Done Section */}
            <div
              id="done-section"
              className="mt-6 pt-5 border-t border-[rgba(255,255,255,0.1)]/60 flex flex-col gap-3 relative z-10"
            >
              {!doneHidden && (
                <button
                  id="done-btn"
                  type="button"
                  className="w-full py-4 rounded-full bg-white/20 text-white font-black text-lg uppercase tracking-widest shadow-xl shadow-white/10 hover:bg-white/30 backdrop-blur-md transition-all platform-btn flex justify-center items-center gap-3 group border border-white/20"
                  disabled={doneDisabled}
                  onClick={handleDoneClick}
                >
                  <span>{doneLabel}</span>
                  <svg
                    className="w-5 h-5 transition-transform group-hover:translate-x-1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M14 5l7 7m0 0l-7 7m7-7H3"
                    />
                  </svg>
                </button>
              )}
              {statusVisible && (
                <p id="status" className={statusClass}>
                  {statusText}
                </p>
              )}
              {postSetupVisible && (
                <div id="post-setup-buttons" className="flex flex-col gap-3 mt-2">
                  {firstTimeHint && (
                    <p
                      id="first-time-hint"
                      className="text-center text-sm font-bold text-amber-400"
                    >
                      {firstTimeHint}
                    </p>
                  )}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <a
                      id="open-dashboard-btn"
                      href={dashboardHref}
                      className="flex-1 py-3 rounded-full bg-white/20 text-white font-bold text-center uppercase tracking-widest hover:bg-white/30 transition-all border border-white/20"
                    >
                      Open Dashboard
                    </a>
                    <button
                      id="return-discord-btn"
                      type="button"
                      className="flex-1 py-3 rounded-full bg-white/20 text-white font-bold uppercase tracking-widest hover:bg-white/30 transition-all border border-white/20"
                      onClick={handleReturnToDiscord}
                    >
                      Return to Discord&reg;
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
