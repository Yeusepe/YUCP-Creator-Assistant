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
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
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
