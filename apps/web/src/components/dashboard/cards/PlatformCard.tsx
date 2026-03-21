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
        className="h-3 w-3 animate-spin"
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
    <div className="platform-row">
      {/* Provider icon */}
      <div className="platform-row-icon" style={iconBg ? { backgroundColor: iconBg } : undefined}>
        {iconPath ? (
          <img src={iconPath} alt={`${label} icon`} />
        ) : (
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'rgba(100,116,139,0.2)',
            }}
          />
        )}
      </div>

      {/* Label and status */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span className="platform-row-label">{label}</span>
        {isConnected ? (
          <span className="platform-row-sub connected">{accountLabel ?? 'Connected'}</span>
        ) : (
          <span className="platform-row-sub">Not linked</span>
        )}
      </div>

      {/* Action area */}
      <div className="platform-row-actions">
        {isAlwaysActive ? (
          <span className="platform-row-badge">Always active</span>
        ) : isConnected ? (
          <button
            type="button"
            disabled={isDisconnecting}
            onClick={onDisconnect}
            className="platform-row-btn disconnect"
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
          <button type="button" onClick={onConnect} className="platform-row-btn">
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
