import { ProgressBar } from '@heroui/react';
import { useMemo } from 'react';

interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  completed: boolean;
  href?: string;
  onClick?: () => void;
}

interface OnboardingProgressPanelProps {
  steps: OnboardingStep[];
  onDismiss?: () => void;
}

function CheckCircle({ completed }: { completed: boolean }) {
  if (completed) {
    return (
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: '#22c55e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        aria-hidden="true"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    );
  }
  return (
    <div
      className="step-circle-empty"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: '2px solid #e2e8f0',
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}

function OnboardingProgressBar({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percentage = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  return (
    <ProgressBar.Root
      value={percentage}
      minValue={0}
      maxValue={100}
      aria-label={`${String(completedCount)} of ${String(totalCount)} steps complete`}
      className="w-full"
    >
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar.Root>
  );
}

export function OnboardingProgressPanel({ steps, onDismiss }: OnboardingProgressPanelProps) {
  const completedCount = useMemo(() => steps.filter((s) => s.completed).length, [steps]);
  const totalCount = steps.length;
  const allComplete = completedCount === totalCount && totalCount > 0;

  if (totalCount === 0) return null;

  return (
    <section
      id="onboarding-progress-panel"
      className="intg-card animate-in"
      aria-label="Getting started checklist"
    >
      {/* Header */}
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Point.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Getting Started</h2>
            <p className="intg-desc">Finish core setup once, then let YUCP handle the rest.</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span className="count-badge">
            {completedCount}/{totalCount}
          </span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                transition: 'background 0.12s ease, color 0.12s ease',
              }}
              className="onboarding-dismiss-btn"
              aria-label="Dismiss getting started checklist"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 16 }}>
        <OnboardingProgressBar completedCount={completedCount} totalCount={totalCount} />
      </div>

      {/* Steps */}
      {allComplete ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <p className="intg-title" style={{ fontSize: 15 }}>
            All set!
          </p>
          <p className="intg-desc" style={{ marginTop: 4 }}>
            All setup steps complete. Your verification system is live.
          </p>
        </div>
      ) : (
        <ul
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {steps.map((step) => {
            const isCompleted = step.completed;
            return (
              <li key={step.id}>
                <div className={`onboarding-step-row${isCompleted ? ' completed' : ''}`}>
                  <CheckCircle completed={isCompleted} />
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <span
                      className="platform-row-label"
                      style={{
                        textDecoration: isCompleted ? 'line-through' : undefined,
                        opacity: isCompleted ? 0.5 : 1,
                      }}
                    >
                      {step.label}
                    </span>
                    <span className="intg-desc" style={{ fontSize: 11 }}>
                      {step.description}
                    </span>
                  </div>
                  {step.href && !isCompleted && (
                    <a
                      href={step.href}
                      onClick={step.onClick}
                      className="onboarding-step-start-btn"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Start
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type { OnboardingStep, OnboardingProgressPanelProps };
