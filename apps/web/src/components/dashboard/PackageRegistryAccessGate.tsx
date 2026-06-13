import { Link } from '@tanstack/react-router';
import { YucpButton } from '@/components/ui/YucpButton';

interface PackageRegistryAccessGateProps {
  mode: 'error' | 'missing';
  className?: string;
  isRetrying?: boolean;
  onRetry?: () => void;
}

export function PackageRegistryAccessGate({
  mode,
  className = 'intg-card animate-in bento-col-12',
  isRetrying = false,
  onRetry,
}: PackageRegistryAccessGateProps) {
  const title =
    mode === 'error' ? 'Could not verify custom VPM repo access' : 'Custom VPM repo required';
  const description =
    mode === 'error'
      ? 'Refresh your billing state and try again.'
      : 'Manage install IDs and VCC links through Polar. Upgrade billing to unlock the custom VPM repo.';

  return (
    <section className={className}>
      <div className="intg-header">
        <div className="intg-icon">
          <img
            src={mode === 'error' ? '/Icons/Wrench.png' : '/Icons/BagPlus.png'}
            alt=""
            aria-hidden="true"
          />
        </div>
        <div className="intg-copy">
          <h2 className="intg-title">{title}</h2>
          <p className="intg-desc">{description}</p>
        </div>
      </div>

      {mode === 'error' ? (
        <YucpButton yucp="primary" pill isLoading={isRetrying} onPress={() => onRetry?.()}>
          Retry
        </YucpButton>
      ) : (
        <Link
          to="/dashboard/billing"
          search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
          className="account-btn account-btn--primary"
          style={{ alignSelf: 'flex-start', borderRadius: '999px' }}
        >
          Upgrade billing
        </Link>
      )}
    </section>
  );
}
