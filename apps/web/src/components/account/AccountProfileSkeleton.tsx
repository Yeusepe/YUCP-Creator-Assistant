import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import {
  SkeletonCircle,
  SkeletonLine,
  SkeletonPill,
  SkeletonTile,
} from '@/components/ui/YucpSkeleton';

const SESSION_STATS = [
  'Sign-in',
  'Creator dashboard',
  'Authorized apps',
  'Providers',
  'Active licenses',
];

export function AccountProfileSkeleton() {
  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Profile"
        title="Discord identity"
        description="This is the identity used across verification, licenses, and authorized apps."
      >
        <div className="account-profile-hero" aria-hidden="true">
          <SkeletonCircle size="72px" />
          <div className="account-profile-hero-copy">
            <SkeletonLine width="min(220px, 62%)" style={{ height: 18 }} />
            <SkeletonLine
              width="min(280px, 78%)"
              className="skeleton-line-muted"
              style={{ height: 12, marginTop: 6 }}
            />
          </div>
        </div>

        <div className="account-pill-row" aria-hidden="true">
          <SkeletonPill width="108px" />
          <SkeletonPill width="122px" />
          <SkeletonPill width="96px" />
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2 account-session-card"
        leading={<SkeletonTile size={44} radius={14} />}
        eyebrow="Session"
        title="Your access"
        description="How you sign in and what this account can use."
        bodyClassName="account-session-card-body"
      >
        <div aria-hidden="true">
          <dl className="account-session-dl">
            {SESSION_STATS.map((label, index) => (
              <div key={label} className="account-session-stat">
                <dt>{label}</dt>
                <dd>
                  <SkeletonLine
                    width={index === 0 ? '96px' : index === 1 ? '48px' : '36px'}
                    style={{ height: 15 }}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="account-session-footer" aria-hidden="true">
          <SkeletonPill width="112px" style={{ height: 36 }} />
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-12 animate-in animate-in-delay-2"
        leading={<SkeletonTile size={44} radius={14} />}
        eyebrow="Account recovery"
        title="Can you get back in if Discord breaks?"
        description="Discord is your normal sign-in. Add backups so you are never stuck."
      >
        <div className="account-status-banner account-status-banner--warning" aria-hidden="true">
          <div className="account-status-banner-copy" style={{ flex: 1 }}>
            <SkeletonLine width="180px" style={{ height: 16 }} />
            <SkeletonLine width="min(460px, 100%)" className="skeleton-line-muted" />
          </div>
        </div>

        <ul className="account-recovery-metrics" aria-hidden="true">
          <li className="account-recovery-metric">
            <span>Passkeys</span>
            <SkeletonPill width="28px" />
          </li>
          <li className="account-recovery-metric">
            <span>Backup codes</span>
            <SkeletonPill width="28px" />
          </li>
          <li className="account-recovery-metric">
            <span>Recovery inboxes</span>
            <SkeletonPill width="28px" />
          </li>
          <li className="account-recovery-metric account-recovery-metric--policy">
            <span>Primary email reset</span>
            <SkeletonPill width="46px" />
          </li>
        </ul>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-12 animate-in animate-in-delay-2"
        eyebrow="Creator mode"
        title="Your creator workspace is getting ready"
        description="Workspace actions and shortcuts appear here once the profile data is ready."
      >
        <SkeletonLine width="min(560px, 100%)" className="skeleton-line-muted" />
        <div className="account-inline-actions" aria-hidden="true">
          <SkeletonPill width="164px" style={{ height: 38 }} />
          <SkeletonPill width="136px" style={{ height: 38 }} />
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
