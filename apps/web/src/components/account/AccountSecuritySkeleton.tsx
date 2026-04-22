import { AccountPage } from '@/components/account/AccountPage';
import { SkeletonLine, SkeletonPill, SkeletonTile } from '@/components/ui/YucpSkeleton';

/**
 * Loading shell that mirrors `/account/security` (overview → recovery board → emergency),
 * so the lazy route pending state matches the real bento layout instead of generic list rows.
 */
export function AccountSecuritySkeleton() {
  return (
    <AccountPage>
      <section
        className="section-card account-surface-card bento-col-12 account-security-skel animate-in"
        aria-hidden
      >
        <div className="account-surface-card-header">
          <div className="account-surface-card-header-cluster">
            <SkeletonTile size={44} radius={14} />
            <div className="account-security-skel-header-copy">
              <SkeletonLine width="100px" style={{ height: 10 }} />
              <SkeletonLine width="min(340px, 72%)" style={{ height: 18 }} />
              <SkeletonLine
                width="min(480px, 94%)"
                className="skeleton-line-muted"
                style={{ height: 12 }}
              />
            </div>
          </div>
          <SkeletonPill width="112px" />
        </div>
        <div className="account-surface-card-body account-security-skel-body">
          <div className="account-security-skel-banner" />
          <div className="account-security-skel-metrics">
            {['a', 'b', 'c', 'd'].map((key) => (
              <SkeletonPill key={key} width="92px" />
            ))}
          </div>
        </div>
      </section>

      <section
        className="section-card account-surface-card bento-col-12 account-security-skel animate-in animate-in-delay-1"
        aria-hidden
      >
        <div className="account-surface-card-header">
          <div className="account-surface-card-copy">
            <SkeletonLine width="88px" style={{ height: 10 }} />
            <SkeletonLine width="min(280px, 70%)" style={{ height: 18 }} />
            <SkeletonLine
              width="min(520px, 100%)"
              className="skeleton-line-muted"
              style={{ height: 12 }}
            />
          </div>
        </div>
        <div className="account-surface-card-body account-security-skel-body">
          <SkeletonLine width="min(400px, 88%)" style={{ height: 13 }} />
          <div className="account-security-skel-board">
            <div className="account-security-skel-board-tile">
              <div className="account-security-skel-tile-head">
                <SkeletonTile size={36} radius={12} />
                <div className="account-security-skel-tile-titles">
                  <SkeletonLine width="56%" />
                  <SkeletonLine
                    width="88%"
                    className="skeleton-line-muted"
                    style={{ height: 11 }}
                  />
                </div>
              </div>
              <SkeletonLine width="100%" className="skeleton-line-muted" />
              <SkeletonPill width="108px" />
            </div>
            <div className="account-security-skel-board-tile">
              <div className="account-security-skel-tile-head">
                <SkeletonTile size={36} radius={12} />
                <div className="account-security-skel-tile-titles">
                  <SkeletonLine width="48%" />
                  <SkeletonLine
                    width="92%"
                    className="skeleton-line-muted"
                    style={{ height: 11 }}
                  />
                </div>
              </div>
              <SkeletonLine width="100%" className="skeleton-line-muted" />
              <SkeletonPill width="132px" />
            </div>
            <div className="account-security-skel-board-tile account-security-skel-board-tile--wide">
              <div className="account-security-skel-tile-head">
                <SkeletonTile size={36} radius={12} />
                <div className="account-security-skel-tile-titles">
                  <SkeletonLine width="40%" />
                  <SkeletonLine
                    width="76%"
                    className="skeleton-line-muted"
                    style={{ height: 11 }}
                  />
                </div>
              </div>
              <div className="account-security-skel-form">
                <SkeletonLine width="72px" style={{ height: 10 }} />
                <SkeletonLine width="100%" style={{ height: 40, borderRadius: 14 }} />
                <SkeletonPill width="96px" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="section-card account-surface-card account-surface-card--security-emergency bento-col-12 account-security-skel animate-in animate-in-delay-2"
        aria-hidden
      >
        <div className="account-surface-card-header">
          <div className="account-surface-card-header-cluster">
            <SkeletonTile size={44} radius={14} />
            <div className="account-security-skel-header-copy">
              <SkeletonLine width="120px" style={{ height: 10 }} />
              <SkeletonLine width="min(260px, 64%)" style={{ height: 18 }} />
              <SkeletonLine
                width="min(440px, 92%)"
                className="skeleton-line-muted"
                style={{ height: 12 }}
              />
            </div>
          </div>
        </div>
        <div className="account-surface-card-body account-security-skel-body">
          <SkeletonLine
            width="min(420px, 90%)"
            className="skeleton-line-muted"
            style={{ height: 12 }}
          />
          <div className="account-security-skel-emergency-actions">
            <SkeletonPill width="124px" />
            <SkeletonPill width="112px" />
            <SkeletonPill width="132px" />
          </div>
        </div>
      </section>
    </AccountPage>
  );
}
