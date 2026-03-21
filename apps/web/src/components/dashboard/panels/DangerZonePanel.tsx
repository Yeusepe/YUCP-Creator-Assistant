import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { uninstallGuild } from '@/lib/dashboard';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface DangerZonePanelProps {
  guildId: string;
}

// ─── Step Definitions ────────────────────────────────────────────────────────

interface DisconnectStepConfig {
  emoji: string;
  title: string;
  text: string;
  buttonLabel: string;
  bgClass: string;
  borderClass: string;
  buttonBgClass: string;
  buttonBorderClass: string;
  titleColorClass: string;
}

const DISCONNECT_STEPS: ReadonlyArray<DisconnectStepConfig | null> = [
  null,
  {
    emoji: '\u26A0\uFE0F',
    title: 'Warning: Disconnect Server',
    text: 'This will permanently remove your server from Creator Assistant. All role rules and verification data for this server will be deleted.',
    buttonLabel: 'I Understand',
    bgClass: 'bg-orange-500/10 dark:bg-orange-500/10',
    borderClass: 'border-orange-500/20 dark:border-orange-500/20',
    buttonBgClass:
      'bg-orange-500/15 hover:bg-orange-500/25 dark:bg-orange-500/15 dark:hover:bg-orange-500/25',
    buttonBorderClass: 'border-orange-500/30 dark:border-orange-500/30',
    titleColorClass: 'text-orange-400',
  },
  {
    emoji: '\uD83D\uDDD1\uFE0F',
    title: 'Delete Server Data',
    text: 'This cannot be undone. Role rules, product mappings, and download routes linked to this guild will be removed.',
    buttonLabel: 'Continue',
    bgClass: 'bg-red-500/10 dark:bg-red-500/10',
    borderClass: 'border-red-500/20 dark:border-red-500/20',
    buttonBgClass: 'bg-red-500/15 hover:bg-red-500/25 dark:bg-red-500/15 dark:hover:bg-red-500/25',
    buttonBorderClass: 'border-red-500/30 dark:border-red-500/30',
    titleColorClass: 'text-red-400',
  },
  {
    emoji: '\uD83D\uDD12',
    title: 'Final Confirmation',
    text: 'Only proceed if you are certain. The bot will be disconnected from this guild and you will return to your personal dashboard.',
    buttonLabel: 'Confirm Disconnect',
    bgClass: 'bg-red-600/15 dark:bg-red-600/15',
    borderClass: 'border-red-600/25 dark:border-red-600/25',
    buttonBgClass: 'bg-red-600/20 hover:bg-red-600/30 dark:bg-red-600/20 dark:hover:bg-red-600/30',
    buttonBorderClass: 'border-red-600/35 dark:border-red-600/35',
    titleColorClass: 'text-red-300',
  },
];

// ─── Sub-components ──────────────────────────────────────────────────────────

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function DisconnectStepCard({
  config,
  isPending,
  isFinalStep,
  onAdvance,
  onBack,
  onConfirm,
}: {
  config: DisconnectStepConfig;
  isPending: boolean;
  isFinalStep: boolean;
  onAdvance: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className={['mt-4 rounded-xl border p-5', config.bgClass, config.borderClass].join(' ')}>
      <div className="flex items-start gap-3.5">
        <div className="text-2xl leading-none" aria-hidden="true">
          {config.emoji}
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <h3
            className={['text-base font-extrabold', config.titleColorClass].join(' ')}
            style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
          >
            {config.title}
          </h3>
          <p
            className="text-[13px] leading-relaxed text-zinc-400 dark:text-white/70"
            style={{ fontFamily: "'DM Sans', sans-serif" }}
          >
            {config.text}
          </p>
          <div className="flex justify-end gap-2">
            <button
              id="dc-step-cancel"
              type="button"
              onClick={onBack}
              className={[
                'rounded-lg border px-4 py-2 text-[13px] font-semibold',
                'bg-white/5 border-white/10 text-zinc-400',
                'transition-all duration-200 hover:bg-white/10',
                'dark:bg-white/5 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/10',
                'cursor-pointer',
              ].join(' ')}
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Cancel
            </button>
            <button
              id="dc-step-next"
              type="button"
              disabled={isPending}
              onClick={isFinalStep ? onConfirm : onAdvance}
              className={[
                'rounded-lg border px-4 py-2 text-[13px] font-semibold',
                config.buttonBgClass,
                config.buttonBorderClass,
                config.titleColorClass,
                'transition-all duration-200',
                isPending ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              ].join(' ')}
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              {isPending && isFinalStep ? 'Disconnecting\u2026' : config.buttonLabel}
            </button>
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

  return (
    <section id="danger-zone-panel" aria-label="Danger Zone" className="col-span-full">
      <h2
        className="mb-4 text-base font-bold tracking-tight text-red-500"
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        Danger Zone
      </h2>

      {/* Disconnect row */}
      <article
        className={[
          'flex items-center gap-4 rounded-xl border px-4 py-3',
          'border-red-500/15 dark:border-red-500/15',
        ].join(' ')}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-500">
          <TrashIcon />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="text-sm font-semibold text-zinc-900 dark:text-white"
            style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
          >
            Disconnect Server
          </span>
          <span
            className="text-xs text-zinc-500 dark:text-zinc-400"
            style={{ fontFamily: "'DM Sans', sans-serif" }}
          >
            Permanently remove this server and delete all verification data.
          </span>
        </div>
        <button
          id="server-disconnect-btn"
          type="button"
          onClick={() => setDisconnectStep((current) => (current === 0 ? 1 : 0))}
          className={[
            'shrink-0 rounded-[10px] px-4 py-2 text-[13px] font-bold',
            'bg-red-500/10 border border-red-500/30 text-red-500',
            'transition-all duration-200 hover:bg-red-500/20',
            'cursor-pointer whitespace-nowrap',
          ].join(' ')}
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
        >
          Disconnect
        </button>
      </article>

      {/* Multi-step confirmation */}
      {stepConfig ? (
        <DisconnectStepCard
          config={stepConfig}
          isPending={uninstallMutation.isPending}
          isFinalStep={disconnectStep === 3}
          onAdvance={() => setDisconnectStep((current) => Math.min(3, current + 1))}
          onBack={() => setDisconnectStep(0)}
          onConfirm={() => uninstallMutation.mutate()}
        />
      ) : null}
    </section>
  );
}
