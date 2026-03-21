export interface PlatformCardProps {
  providerKey: string;
  label: string;
  iconPath: string | null;
  iconBg?: string;
  isConnected: boolean;
  accountLabel?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  isDisconnecting?: boolean;
  isAlwaysActive?: boolean;
}

function LoadingSpinner() {
  return (
    <span className="btn-loading-spinner" aria-hidden="true">
      <svg
        className="h-4 w-4 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M12 2a10 10 0 0 1 10 10" />
      </svg>
    </span>
  );
}

export function PlatformCard({
  label,
  iconPath,
  iconBg,
  isConnected,
  accountLabel,
  onConnect,
  onDisconnect,
  isDisconnecting,
  isAlwaysActive,
}: PlatformCardProps) {
  return (
    <div
      className={[
        'flex items-center gap-4 rounded-xl px-4 py-3',
        'bg-zinc-50/80 border border-zinc-200/60',
        'transition-colors duration-200',
        'hover:bg-zinc-100/80 hover:border-zinc-300/60',
        'dark:bg-[rgba(15,23,42,0.5)] dark:border-white/10',
        'dark:hover:bg-[rgba(30,41,59,0.6)] dark:hover:border-white/15',
      ].join(' ')}
    >
      {/* Provider icon */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={iconBg ? { backgroundColor: iconBg } : undefined}
      >
        {iconPath ? (
          <img src={iconPath} alt={`${label} icon`} className="h-5 w-5 object-contain" />
        ) : (
          <div className="h-5 w-5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        )}
      </div>

      {/* Label and status */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate text-sm font-bold text-zinc-900 dark:text-white"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {label}
        </span>
        {isConnected ? (
          <span className="truncate text-xs text-emerald-600 dark:text-emerald-400">
            {accountLabel ?? 'Connected'}
          </span>
        ) : (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Not linked</span>
        )}
      </div>

      {/* Action area */}
      <div className="shrink-0">
        {isAlwaysActive ? (
          <span className="inline-flex items-center rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
            Always active
          </span>
        ) : isConnected ? (
          <button
            type="button"
            disabled={isDisconnecting}
            onClick={onDisconnect}
            className={[
              'inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              isDisconnecting
                ? 'pointer-events-none border-zinc-200 text-zinc-400 opacity-70 dark:border-zinc-700 dark:text-zinc-500'
                : 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30',
            ].join(' ')}
          >
            {isDisconnecting ? (
              <>
                <LoadingSpinner />
                Disconnecting...
              </>
            ) : (
              'Disconnect'
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className={[
              'inline-flex items-center rounded-full px-4 py-1.5 text-xs font-semibold',
              'bg-zinc-900 text-white',
              'transition-colors duration-150',
              'hover:bg-zinc-800',
              'dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100',
            ].join(' ')}
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
