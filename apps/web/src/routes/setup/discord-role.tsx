import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/setup/discord-role')({
  head: () => ({
    meta: [{ title: 'Discord® Role Setup | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.discordRoleSetup),
  }),
  component: DiscordRoleSetupPage,
});

/* ── Helpers ────────────────────────────────────────────────────────── */

type View = 'signin' | 'pick' | 'success' | 'error';

function parseRoleIds(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateRoleIds(roleIds: string[]): { ok: boolean; msg?: string } {
  const valid = /^\d{17,20}$/;
  for (const id of roleIds) {
    if (!valid.test(id))
      return {
        ok: false,
        msg: `Invalid Role ID: "${id}". Must be 17-20 digits.`,
      };
  }
  return { ok: true };
}

function getErrorMessage(code: string): string {
  const msgs: Record<string, string> = {
    missing_parameters: 'Authorization was cancelled or failed. Please try again.',
    invalid_state: 'Session mismatch. Please try signing in again.',
    token_exchange_failed: 'Failed to exchange Discord authorization. Please try again.',
    no_token: 'No authorization token received from Discord. Please try again.',
    guilds_fetch_failed: 'Failed to fetch your server list from Discord. Please try again.',
    session_expired: 'Your setup session has expired. Please go back to Discord and start over.',
    internal_error: 'An unexpected error occurred. Please try again.',
  };
  return msgs[code] || `Error: ${code}`;
}

/* ── Reusable Discord SVG icon ──────────────────────────────────────── */

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.053a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

/* ── Page Component ─────────────────────────────────────────────────── */

function DiscordRoleSetupPage() {
  const [view, setView] = useState<View>('signin');
  const [guilds, setGuilds] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [roleIdsText, setRoleIdsText] = useState('');
  const [matchMode, setMatchMode] = useState<'any' | 'all'>('any');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successData, setSuccessData] = useState<{
    guildName: string;
    roleIds: string[];
    matchMode: string;
  } | null>(null);

  /* ── Bootstrap: exchange hash token then fetch session ─────────── */
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const hashToken = hash.get('s');

      if (hashToken) {
        try {
          const res = await fetch('/api/setup/discord-role-session/exchange', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: hashToken }),
          });
          if (!res.ok) {
            if (!cancelled) setView('error');
            return;
          }
          window.history.replaceState({}, '', window.location.pathname + window.location.search);
          window.location.reload();
          return;
        } catch {
          if (!cancelled) setView('error');
          return;
        }
      }

      const params = new URLSearchParams(window.location.search);
      const errorCode = params.get('error');

      let session: {
        completed?: boolean;
        sourceGuildName?: string;
        sourceGuildId?: string;
        sourceRoleIds?: string[];
        sourceRoleId?: string;
        requiredRoleMatchMode?: string;
        guilds?: Array<{ id: string; name: string }>;
      };

      try {
        const res = await fetch('/api/setup/discord-role-guilds', {
          credentials: 'include',
        });
        if (!res.ok) {
          if (!cancelled) setView('error');
          return;
        }
        session = await res.json();
      } catch {
        if (!cancelled) setView('error');
        return;
      }

      if (cancelled) return;

      if (session.completed) {
        const guildName = session.sourceGuildName ?? session.sourceGuildId ?? '';
        const roleIds =
          session.sourceRoleIds ?? (session.sourceRoleId ? [session.sourceRoleId] : []);
        const mode = session.requiredRoleMatchMode ?? 'any';
        setSuccessData({ guildName, roleIds, matchMode: mode });
        setView('success');
        return;
      }

      if (session.guilds) {
        setGuilds(session.guilds);
        if (errorCode) setError(getErrorMessage(errorCode));
        setView('pick');
      } else {
        if (errorCode) setError(getErrorMessage(errorCode));
        setView('signin');
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Save selection ────────────────────────────────────────────── */
  const handleSave = useCallback(async () => {
    setError(null);

    if (!selectedGuild) {
      setError('Please select a server.');
      return;
    }

    const roleIds = parseRoleIds(roleIdsText);
    if (roleIds.length === 0) {
      setError('Please add at least one role ID (one per line or comma-separated).');
      return;
    }

    const validation = validateRoleIds(roleIds);
    if (!validation.ok) {
      setError(validation.msg ?? 'Invalid role ID.');
      return;
    }

    const guildName = guilds.find((g) => g.id === selectedGuild)?.name ?? selectedGuild;

    setIsSaving(true);
    try {
      const res = await fetch('/api/setup/discord-role-save', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceGuildId: selectedGuild,
          sourceGuildName: guildName,
          sourceRoleIds: roleIds,
          requiredRoleMatchMode: matchMode,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to save. Please try again.');
        setIsSaving(false);
        return;
      }

      setSuccessData({ guildName, roleIds, matchMode });
      setView('success');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [selectedGuild, roleIdsText, matchMode, guilds]);

  /* ── Derived values ────────────────────────────────────────────── */
  const showDots = view === 'signin' || view === 'pick';
  const oauthLink = '/api/setup/discord-role-oauth/begin';

  /* ── Render ────────────────────────────────────────────────────── */
  return (
    <div
      className="discord-role-setup flex items-start sm:items-center justify-center p-4 sm:p-6"
      style={{
        minHeight: '100dvh',
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="w-full max-w-md animate-in" style={{ width: '100%' }}>
        {/* Header */}
        <div className="text-center mb-8">
          <img
            src="/Icons/MainLogo.png"
            alt="Creator Assistant"
            className="h-8 sm:h-10 max-w-full w-auto object-contain object-center flex-shrink-0 mx-auto mb-5 opacity-90"
          />
          <div className="inline-flex items-center gap-2.5 bg-[#5865F2]/20 border border-[#5865F2]/30 rounded-full px-4 py-1.5 mb-4">
            <DiscordIcon className="w-4 h-4 text-[#7289da]" />
            <span className="font-heading text-[11px] font-black uppercase tracking-widest text-[#a5b4fc]">
              Discord® Role Setup
            </span>
          </div>
          <h1 className="text-3xl font-black text-white mb-2">Pick a server &amp; role</h1>
          <p className="text-sm text-white/60" style={{ fontFamily: "'DM Sans', sans-serif" }}>
            Set which Discord® role grants verification access.
          </p>
        </div>

        {/* Step dots */}
        {showDots && (
          <div className="step-dots">
            <div className={`step-dot ${view === 'signin' ? 'active' : 'done'}`} />
            <div className={`step-dot ${view === 'pick' ? 'active' : ''}`} />
          </div>
        )}

        {/* ── Sign in ────────────────────────────────────────────── */}
        {view === 'signin' && (
          <div className="card">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0">
                <DiscordIcon className="w-5 h-5 text-[#7289da]" />
              </div>
              <div>
                <h2
                  className="font-heading text-lg text-white"
                  style={{ letterSpacing: '-0.02em' }}
                >
                  Sign in with Discord®
                </h2>
                <p
                  className="text-xs text-white/50"
                  style={{ fontFamily: "'DM Sans', sans-serif" }}
                >
                  Step 1 of 2
                </p>
              </div>
            </div>

            <p
              className="text-sm text-white/65 mb-6 leading-relaxed"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              We need to see which Discord® servers you're in so you can pick one - no typing server
              IDs required. We only read your server list, nothing else.
            </p>

            {error && (
              <div className="error-box mb-5">
                <img src="/Icons/X.png" className="error-box-icon" alt="" />
                <span>{error}</span>
              </div>
            )}

            <a href={oauthLink} className="btn-discord">
              <img src="/Icons/Discord.png" width={20} height={20} alt="" />
              Continue with Discord®
            </a>

            <p
              className="text-center text-xs text-white/30 mt-4"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              Only your server list is accessed. No messages or permissions.
            </p>
          </div>
        )}

        {/* ── Pick server & role ─────────────────────────────────── */}
        {view === 'pick' && (
          <div className="card">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0">
                <img src="/Icons/PersonKey.png" className="w-5 h-5 object-contain" alt="" />
              </div>
              <div>
                <h2
                  className="font-heading text-lg text-white"
                  style={{ letterSpacing: '-0.02em' }}
                >
                  Pick a server and role
                </h2>
                <p
                  className="text-xs text-white/50"
                  style={{ fontFamily: "'DM Sans', sans-serif" }}
                >
                  Step 2 of 2
                </p>
              </div>
            </div>

            <p
              className="text-sm text-white/65 mb-6 leading-relaxed"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              Select the server where users must have a role, then enter that role's ID.
            </p>

            {/* Server dropdown */}
            <div className="mb-5">
              <label className="form-label" htmlFor="guild-select">
                Source Server
              </label>
              <select
                id="guild-select"
                value={selectedGuild}
                onChange={(e) => setSelectedGuild(e.target.value)}
              >
                <option value="">- Select a server -</option>
                {guilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Role IDs */}
            <div className="mb-2">
              <label className="form-label" htmlFor="role-ids-input">
                Required Role(s)
              </label>
              <textarea
                id="role-ids-input"
                rows={3}
                placeholder={'One role ID per line, e.g.:\n123456789012345678\n987654321098765432'}
                className="w-full rounded-xl border border-white/15 bg-black/20 px-4 py-3 text-white placeholder-white/30 focus:border-[#5865F2] focus:outline-none focus:ring-1 focus:ring-[#5865F2] font-mono text-sm"
                style={{ fontSize: '16px' }}
                value={roleIdsText}
                onChange={(e) => setRoleIdsText(e.target.value)}
              />
              <p
                className="text-xs text-white/50 mt-1"
                style={{ fontFamily: "'DM Sans', sans-serif" }}
              >
                Users must have these roles in the source server. Add one or more.
              </p>

              <div className="helper-box mt-2">
                <div className="helper-step">
                  <div className="helper-num">1</div>
                  <span>Open the target server in Discord®</span>
                </div>
                <div className="helper-step">
                  <div className="helper-num">2</div>
                  <span>
                    Go to <strong className="text-white/80">Server Settings &rarr; Roles</strong>
                  </span>
                </div>
                <div className="helper-step">
                  <div className="helper-num">3</div>
                  <span>
                    Right-click the role &rarr;{' '}
                    <strong className="text-white/80">Copy Role ID</strong>
                    <br />
                    <span className="text-white/40">
                      (Requires Developer Mode: User Settings &rarr; Advanced &rarr; Developer Mode)
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* Match mode */}
            <div className="mb-5 mt-4">
              <span className="form-label">Verification rule</span>
              <div className="option-pill-group">
                <label className="option-pill">
                  <input
                    type="radio"
                    name="match-mode"
                    value="any"
                    checked={matchMode === 'any'}
                    onChange={() => setMatchMode('any')}
                  />
                  <span>
                    User must have <strong>any</strong> of these roles
                  </span>
                </label>
                <label className="option-pill">
                  <input
                    type="radio"
                    name="match-mode"
                    value="all"
                    checked={matchMode === 'all'}
                    onChange={() => setMatchMode('all')}
                  />
                  <span>
                    User must have <strong>all</strong> of these roles
                  </span>
                </label>
              </div>
              <p
                className="text-xs text-white/50 mt-1"
                style={{ fontFamily: "'DM Sans', sans-serif" }}
              >
                Choose whether the user needs at least one role or every role.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="error-box mt-4">
                <img src="/Icons/X.png" className="error-box-icon" alt="" />
                <span>{error}</span>
              </div>
            )}

            {/* Save */}
            <button
              type="button"
              className="btn-primary mt-5"
              disabled={isSaving}
              onClick={handleSave}
            >
              {isSaving ? (
                <>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: 'white',
                      borderRadius: '50%',
                      animation: 'spin 0.7s linear infinite',
                    }}
                  />
                  Saving...
                </>
              ) : (
                <>
                  <img src="/Icons/Checkmark.png" className="w-4 h-4 object-contain" alt="" />
                  Save Selection
                </>
              )}
            </button>
          </div>
        )}

        {/* ── Success ────────────────────────────────────────────── */}
        {view === 'success' && successData && (
          <div className="card text-center">
            <div className="success-glow">
              <img src="/Icons/Checkmark.png" className="w-10 h-10 object-contain" alt="Success" />
            </div>
            <h2 className="font-heading text-2xl text-white mb-2">Selection saved!</h2>
            <p
              className="text-sm text-white/60 mb-5 leading-relaxed"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              Your Discord® role requirement has been configured.
            </p>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 mb-6 text-left space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                  Server
                </span>
                <span className="text-sm font-bold text-white">{successData.guildName}</span>
              </div>
              <div className="border-t border-white/8" />
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                  Required roles
                </span>
                <span className="text-sm text-white/90">
                  {successData.roleIds.length === 1
                    ? successData.roleIds[0]
                    : `${successData.roleIds.length} roles`}
                </span>
              </div>
              <div className="border-t border-white/8" />
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                  Verification rule
                </span>
                <span className="text-sm text-white/90">
                  {successData.matchMode === 'all' ? 'All roles required' : 'Any role'}
                </span>
              </div>
            </div>

            <div className="bg-[#5865F2]/10 border border-[#5865F2]/25 rounded-2xl p-4 flex items-start gap-3 text-left">
              <DiscordIcon className="w-5 h-5 text-[#7289da] flex-shrink-0 mt-0.5" />
              <p className="text-sm text-white/70" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                Go back to Discord® and click{' '}
                <strong className="text-white">"Done, I've selected it"</strong> to finish setup.
              </p>
            </div>
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────── */}
        {view === 'error' && (
          <div className="card text-center">
            <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-5">
              <img src="/Icons/X.png" className="w-8 h-8 object-contain" alt="Error" />
            </div>
            <h2 className="font-heading text-xl text-white mb-2">Invalid or expired link</h2>
            <p
              className="text-sm text-white/60 leading-relaxed"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              This setup link has expired or is invalid.
              <br />
              Go back to Discord® and run <code>/creator-admin product add</code> again to get a new
              one.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
