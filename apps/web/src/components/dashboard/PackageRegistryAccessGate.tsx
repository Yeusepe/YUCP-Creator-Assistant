import { Link } from '@tanstack/react-router';
import { Icon } from '@/components/ui/Icon';
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
    mode === 'error' ? 'We couldn’t check Unity install access' : 'Set up Unity install access';
  const description =
    mode === 'error'
      ? 'Refresh billing and try again.'
      : 'Manage install links through Polar. Upgrade your plan to let buyers install private Unity products.';

  return (
    <section className={className}>
      <div className="intg-header">
        <div className="intg-icon">
          <Icon name={mode === 'error' ? 'alert' : 'package'} />
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
          to="/account/billing"
          className="account-btn account-btn--primary"
          style={{ alignSelf: 'flex-start', borderRadius: '999px' }}
        >
          Upgrade plan
        </Link>
      )}
    </section>
  );
}
