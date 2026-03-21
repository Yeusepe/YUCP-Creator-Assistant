import { type ReactNode } from 'react';

export interface QuickActionCardProps {
  label: string;
  description: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}

const SHARED_CLASSES = [
  'flex flex-col items-start gap-3 rounded-xl p-4',
  'bg-white/55 backdrop-blur-md border border-white/60',
  'transition-all duration-200',
  'dark:bg-slate-800/45 dark:border-white/8',
].join(' ');

const INTERACTIVE_CLASSES = [
  'hover:border-white/80 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]',
  'dark:hover:border-white/15 dark:hover:bg-slate-800/55',
  'cursor-pointer',
].join(' ');

const DISABLED_CLASSES = 'pointer-events-none opacity-50';

function CardContent({
  icon,
  label,
  description,
}: Pick<QuickActionCardProps, 'icon' | 'label' | 'description'>) {
  return (
    <>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-400">
        {icon}
      </div>
      <div className="flex flex-col gap-0.5">
        <span
          className="text-sm font-semibold text-zinc-900 dark:text-white"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{description}</span>
      </div>
    </>
  );
}

export function QuickActionCard({
  label,
  description,
  icon,
  onClick,
  href,
  disabled,
}: QuickActionCardProps) {
  const className = [SHARED_CLASSES, disabled ? DISABLED_CLASSES : INTERACTIVE_CLASSES].join(' ');

  if (href && !disabled) {
    return (
      <a href={href} className={className}>
        <CardContent icon={icon} label={label} description={description} />
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      <CardContent icon={icon} label={label} description={description} />
    </button>
  );
}
