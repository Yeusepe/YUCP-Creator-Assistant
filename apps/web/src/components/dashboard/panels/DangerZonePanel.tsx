import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { HoldConfirmButton } from '@/components/ui/HoldConfirmButton';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { uninstallGuild } from '@/lib/dashboard';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface DangerZonePanelProps {
  guildId: string;
}

// ─── Step Definitions ────────────────────────────────────────────────────────

type StepAccent = 'amber' | 'rose' | 'red';

interface DisconnectStepConfig {
  title: string;
  text: string;
  buttonLabel: string;
  accent: StepAccent;
}

const DISCONNECT_STEPS: ReadonlyArray<DisconnectStepConfig | null> = [
  null,
  {
    title: 'Warning: Disconnect Server',
    text: 'This will permanently remove your server from Creator Assistant. All role rules and verification data for this server will be deleted.',
    buttonLabel: 'I Understand',
    accent: 'amber',
  },
  {
    title: 'Delete Server Data',
    text: 'This cannot be undone. Role rules, product mappings, and download routes linked to this guild will be removed.',
    buttonLabel: 'Continue',
    accent: 'rose',
  },
  {
    title: 'Final Confirmation',
    text: 'Only proceed if you are certain. The bot will be disconnected from this guild and you will return to your personal dashboard.',
    buttonLabel: 'Confirm Disconnect',
    accent: 'red',
  },
];

const ACCENT: Record<
  StepAccent,
  { bar: string; iconWrap: string; iconStroke: string; surface: string; ring: string }
> = {
  amber: {
    bar: 'bg-amber-500',
    iconWrap:
      'border-amber-200/60 bg-gradient-to-br from-amber-50 to-white text-amber-600 dark:border-amber-500/25 dark:from-amber-950/40 dark:to-red-950/20 dark:text-amber-400',
    iconStroke: 'stroke-amber-600 dark:stroke-amber-400',
    surface: 'border-amber-200/50 bg-amber-50/40 dark:border-amber-500/20 dark:bg-amber-950/20',
    ring: 'ring-amber-500/15',
  },
  rose: {
    bar: 'bg-rose-500',
    iconWrap:
      'border-rose-200/60 bg-gradient-to-br from-rose-50 to-white text-rose-600 dark:border-rose-500/25 dark:from-rose-950/40 dark:to-red-950/20 dark:text-rose-400',
    iconStroke: 'stroke-rose-600 dark:stroke-rose-400',
    surface: 'border-rose-200/50 bg-rose-50/40 dark:border-rose-500/20 dark:bg-rose-950/20',
    ring: 'ring-rose-500/15',
  },
  red: {
    bar: 'bg-red-600',
    iconWrap:
      'border-red-200/60 bg-gradient-to-br from-red-50 to-white text-red-600 dark:border-red-500/30 dark:from-red-950/50 dark:to-red-950/20 dark:text-red-300',
    iconStroke: 'stroke-red-600 dark:stroke-red-400',
    surface: 'border-red-200/50 bg-red-50/50 dark:border-red-500/25 dark:bg-red-950/25',
    ring: 'ring-red-500/20',
  },
};

// ─── Icons ─────────────────────────────────────────────────────────────────────

function TrashIcon() {
  return <Icon name="trash" size={16} />;
}

function AlertTriangleIcon({ className }: { className?: string }) {
  return <Icon name="alert" className={className} size={22} />;
}

function LockIcon({ className }: { className?: string }) {
  return <Icon name="lock" className={className} size={20} />;
}

function StepIcons({ step }: { step: 1 | 2 | 3 }) {
  const stepCfg = DISCONNECT_STEPS[step];
  if (!stepCfg) {
    return null;
  }
  const stroke = ACCENT[stepCfg.accent].iconStroke;
  if (step === 1) {
    return <AlertTriangleIcon className={stroke} />;
  }
  if (step === 2) {
    return <Icon name="trash" className={stroke} size={20} />;
  }
  return <LockIcon className={stroke} />;
}

function StepProgressPips({ currentStep }: { currentStep: 1 | 2 | 3 }) {
  return (
    <ol
      className="m-0 flex list-none items-center gap-2 p-0"
      aria-label="Disconnect confirmation progress"
    >
      {([1, 2, 3] as const).map((n) => {
        const done = n < currentStep;
        const active = n === currentStep;
        const stepCfg = DISCONNECT_STEPS[n];
        const accent = stepCfg ? ACCENT[stepCfg.accent] : ACCENT.amber;
        return (
          <li
            key={n}
            className="flex items-center gap-2"
            aria-current={active ? 'step' : undefined}
          >
            {n > 1 ? (
              <div
                className={[
                  'h-px w-4 shrink-0 rounded-full',
                  done ? accent.bar : 'bg-zinc-200 dark:bg-white/10',
                ].join(' ')}
                aria-hidden="true"
              />
            ) : null}
            <div
              className={[
                'flex h-7 min-w-7 items-center justify-center rounded-full text-[10px] font-bold tabular-nums transition-colors',
                done
                  ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                  : active
                    ? [accent.bar, 'text-white'].join(' ')
                    : 'border border-zinc-200 bg-white text-zinc-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-500',
              ].join(' ')}
            >
              {done ? '✓' : n}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DisconnectStepCard({
  config,
  stepIndex,
  isPending,
  isFinalStep,
  onAdvance,
  onBack,
  onConfirm,
}: {
  config: DisconnectStepConfig;
  stepIndex: 1 | 2 | 3;
  isPending: boolean;
  isFinalStep: boolean;
  onAdvance: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const a = ACCENT[config.accent];
  return (
    <div
      className={['mt-4 overflow-hidden rounded-2xl border', a.surface, 'ring-1', a.ring].join(' ')}
    >
      <div
        className="border-b border-black/[0.06] bg-white/40 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]"
        style={{ fontFamily: "var(--font-display), 'Plus Jakarta Sans', sans-serif" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
            Confirm disconnect
          </p>
          <StepProgressPips currentStep={stepIndex} />
        </div>
      </div>

      <div className="p-4 sm:p-5">
        <div className="flex gap-4">
          <div
            className={[
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border',
              a.iconWrap,
            ].join(' ')}
            aria-hidden="true"
          >
            <StepIcons step={stepIndex} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="space-y-2">
              <h3
                className="m-0 text-base font-bold tracking-tight text-zinc-900 dark:text-white"
                style={{ fontFamily: "var(--font-display), 'Plus Jakarta Sans', sans-serif" }}
              >
                {config.title}
              </h3>
              <p
                className="m-0 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300/90"
                style={{ fontFamily: "'AirbnbCereal', sans-serif" }}
              >
                {config.text}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-0.5">
              <YucpButton
                id="dc-step-cancel"
                yucp="ghost"
                onPress={onBack}
                className="!text-[12px] !px-3.5"
              >
                Cancel
              </YucpButton>
              {isFinalStep ? (
                <HoldConfirmButton
                  accessibleLabel="Hold to confirm server disconnect"
                  confirmLabel="Keep holding to disconnect..."
                  isPending={isPending}
                  onConfirm={onConfirm}
                  pendingLabel="Disconnecting..."
                >
                  {config.buttonLabel}
                </HoldConfirmButton>
              ) : (
                <YucpButton
                  id="dc-step-next"
                  yucp="primary"
                  onPress={onAdvance}
                  className={[
                    'border-0 !text-[12px] !px-3.5',
                    config.accent === 'amber'
                      ? '!bg-amber-500 hover:!bg-amber-600 !text-white'
                      : config.accent === 'rose'
                        ? '!bg-rose-600 hover:!bg-rose-700 !text-white'
                        : '',
                  ].join(' ')}
                >
                  {config.buttonLabel}
                </YucpButton>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function DangerZonePanel({ guildId }: DangerZonePanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [disconnectStep, setDisconnectStep] = useState(0);

  const uninstallMutation = useMutation({
    mutationFn: () => uninstallGuild(guildId),
    onSuccess: async () => {
      setDisconnectStep(0);
      toast.success('Server disconnected successfully');
      await queryClient.invalidateQueries({ queryKey: ['dashboard-guilds'] });
      navigate({ to: '/dashboard', search: {} });
    },
    onError: () => {
      setDisconnectStep(0);
      toast.error('Could not disconnect server', {
        description: 'Please try again or contact support.',
        duration: 6000,
      });
    },
  });

  const stepConfig = DISCONNECT_STEPS[disconnectStep] ?? null;
  const stepIndex = (disconnectStep >= 1 && disconnectStep <= 3 ? disconnectStep : 1) as 1 | 2 | 3;

  return (
    <section
      id="danger-zone-panel"
      aria-label="Danger Zone"
      className="intg-card border border-red-200/40 !shadow-none ring-1 ring-red-500/10 hover:!shadow-none dark:border-red-500/20 dark:ring-red-500/10"
    >
      <div className="intg-header !border-red-200/25 dark:!border-red-500/15">
        <div className="intg-title-row">
          <div className="intg-icon !border-red-200/50 !bg-gradient-to-br from-red-50/90 to-white !text-red-500 !shadow-none dark:!border-red-500/25 dark:!from-red-950/40 dark:!to-slate-900/30 dark:!text-red-400 [&>svg]:!stroke-red-500 dark:[&>svg]:!stroke-red-400">
            <TrashIcon />
          </div>
          <div className="intg-copy">
            <h2
              className="intg-title text-red-700 dark:text-red-400/95"
              style={{ fontFamily: "var(--font-display), 'Plus Jakarta Sans', sans-serif" }}
            >
              Danger Zone
            </h2>
            <p className="intg-desc">
              Destructive actions for removing this server from the creator workflow.
            </p>
          </div>
        </div>
      </div>

      <article className="my-0 flex items-center gap-4 rounded-[18px] border border-zinc-200/80 bg-slate-50/90 p-4 shadow-none dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-red-200/40 bg-gradient-to-br from-red-50 to-white text-red-500 dark:border-red-500/20 dark:from-red-950/30 dark:to-red-950/5 dark:text-red-400">
          <TrashIcon />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="text-sm font-semibold text-zinc-900 dark:text-white"
            style={{ fontFamily: "var(--font-display), 'Plus Jakarta Sans', sans-serif" }}
          >
            Disconnect Server
          </span>
          <span
            className="text-xs text-zinc-500 dark:text-zinc-400"
            style={{ fontFamily: "'AirbnbCereal', sans-serif" }}
          >
            Permanently remove this server and delete all verification data.
          </span>
        </div>
        <YucpButton
          id="server-disconnect-btn"
          yucp="ghost"
          onPress={() => setDisconnectStep((current) => (current === 0 ? 1 : 0))}
          className="!shrink-0 !whitespace-nowrap !border !border-red-200 !bg-red-50 !text-red-600 hover:!bg-red-100 dark:!border-red-500/30 dark:!bg-red-950/30 dark:!text-red-400 dark:hover:!bg-red-950/50"
        >
          Disconnect
        </YucpButton>
      </article>

      {stepConfig ? (
        <DisconnectStepCard
          config={stepConfig}
          stepIndex={stepIndex}
          isPending={uninstallMutation.isPending}
          isFinalStep={disconnectStep === 3}
          onAdvance={() => setDisconnectStep((current) => Math.min(3, current + 1))}
          onBack={() => setDisconnectStep((current) => Math.max(0, current - 1))}
          onConfirm={() => uninstallMutation.mutate()}
        />
      ) : null}
    </section>
  );
}
