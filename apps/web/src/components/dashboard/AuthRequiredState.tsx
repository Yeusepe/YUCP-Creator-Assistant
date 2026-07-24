import { Icon } from '@/components/ui/Icon';

export function DashboardAuthRequiredState({
  title,
  description,
  id,
}: {
  title: string;
  description: string;
  id?: string;
}) {
  return (
    <section className="intg-card bento-col-12 animate-in" id={id}>
      <div className="empty-state">
        <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
          <Icon name="lock" size={18} />
        </div>
        <p className="text-sm font-semibold" style={{ fontFamily: "'AirbnbCereal',sans-serif" }}>
          {title}
        </p>
        <p
          className="text-xs mt-2 max-w-xs mx-auto"
          style={{ fontFamily: "'AirbnbCereal',sans-serif" }}
        >
          {description}
        </p>
      </div>
    </section>
  );
}
