import { useMemo } from 'react';

interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  completed: boolean;
  href?: string;
}

interface OnboardingProgressPanelProps {
  steps: OnboardingStep[];
  onDismiss?: () => void;
}

function CheckCircle({ completed }: { completed: boolean }) {
  if (completed) {
    return (
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
        aria-hidden="true"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
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
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-zinc-300 dark:border-zinc-600"
      aria-hidden="true"
    />
  );
}

function ProgressBar({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percentage = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10"
      role="progressbar"
      aria-valuenow={completedCount}
      aria-valuemin={0}
      aria-valuemax={totalCount}
      aria-label={`${completedCount} of ${totalCount} steps complete`}
    >
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-500 ease-out"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function CongratulationsState() {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="relative">
        {/* Confetti accents */}
        <div
          className="absolute -top-2 -left-3 h-2 w-2 rotate-12 rounded-sm bg-amber-400"
          aria-hidden="true"
        />
        <div
          className="absolute -top-1 left-6 h-1.5 w-1.5 -rotate-12 rounded-sm bg-sky-400"
          aria-hidden="true"
        />
        <div
          className="absolute top-0 -right-2 h-2 w-2 rotate-45 rounded-sm bg-emerald-400"
          aria-hidden="true"
        />
        <div
          className="absolute -top-3 right-5 h-1.5 w-1.5 rotate-6 rounded-sm bg-purple-400"
          aria-hidden="true"
        />
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
      </div>
      <p
        className="mt-4 text-lg font-bold text-zinc-900 dark:text-white"
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        All set!
      </p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        You have completed all onboarding steps. You are ready to go.
      </p>
    </div>
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
          <div className="flex items-center gap-2">
            <h2 className="intg-title">Getting Started</h2>
            <span className="text-sm text-zinc-400 dark:text-zinc-500">
              {completedCount}/{totalCount} complete
            </span>
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-zinc-300"
            aria-label="Dismiss getting started checklist"
          >
            <svg
              width="16"
              height="16"
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

      {/* Progress bar */}
      <div className="pb-4">
        <ProgressBar completedCount={completedCount} totalCount={totalCount} />
      </div>

      {/* Content */}
      <div>
        {allComplete ? (
          <CongratulationsState />
        ) : (
          <ul className="flex flex-col gap-1">
            {steps.map((step) => (
              <li key={step.id}>
                <div
                  className={[
                    'flex items-start gap-3 rounded-xl px-3 py-3 transition-colors duration-150',
                    step.completed ? 'opacity-60' : 'hover:bg-zinc-50 dark:hover:bg-white/5',
                  ].join(' ')}
                >
                  <CheckCircle completed={step.completed} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={[
                        'text-sm font-semibold',
                        step.completed
                          ? 'text-zinc-400 line-through dark:text-zinc-500'
                          : 'text-zinc-900 dark:text-white',
                      ].join(' ')}
                      style={{ fontFamily: "'DM Sans', sans-serif" }}
                    >
                      {step.label}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {step.description}
                    </span>
                  </div>
                  {step.href && !step.completed && (
                    <a
                      href={step.href}
                      className="shrink-0 rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white transition-colors duration-150 hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                    >
                      Start
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export type { OnboardingStep, OnboardingProgressPanelProps };
