import { YucpButton } from '@/components/ui/YucpButton';

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
    <div className="cpp-provider platform-row">
      <div
        className="cpp-provider__icon platform-row-icon"
        style={iconBg ? { backgroundColor: iconBg } : undefined}
      >
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

      <div className="cpp-provider__meta">
        <span className="platform-row-label">{label}</span>
        {isConnected ? (
          <span className="platform-row-sub connected">{accountLabel ?? 'Connected'}</span>
        ) : (
          <span className="platform-row-sub">Not linked</span>
        )}
      </div>

      <div className="cpp-provider__actions platform-row-actions">
        {isAlwaysActive ? (
          <span className="platform-row-badge">Always active</span>
        ) : isConnected ? (
          <YucpButton
            yucp="danger"
            isLoading={isDisconnecting}
            onPress={onDisconnect}
            className="platform-row-btn disconnect"
          >
            {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
          </YucpButton>
        ) : (
          <YucpButton yucp="primary" onPress={onConnect} className="platform-row-btn">
            Connect
          </YucpButton>
        )}
      </div>
    </div>
  );
}
