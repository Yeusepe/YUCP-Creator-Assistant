import { useState } from 'react';

export function DashboardPanelErrorState({
  id,
  title,
  description,
  requestId,
  onRetry,
}: {
  id: string;
  title: string;
  description: string;
  requestId?: string;
  onRetry?: () => Promise<unknown> | unknown;
}) {
  const [isRetrying, setIsRetrying] = useState(false);

  return (
    <div id={id} className="platform-card disconnected">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-base mb-1">{title}</h3>
          <p className="text-xs text-white/60" style={{ fontFamily: "'AirbnbCereal',sans-serif" }}>
            {description}
          </p>
          {requestId ? (
            <p
              className="text-xs text-white/50"
              style={{ fontFamily: "'AirbnbCereal',sans-serif", marginTop: '8px' }}
            >
              Request ID: {requestId}
            </p>
          ) : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            className="card-action-btn link"
            disabled={isRetrying}
            onClick={async () => {
              setIsRetrying(true);
              try {
                await onRetry();
              } finally {
                setIsRetrying(false);
              }
            }}
          >
            {isRetrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
