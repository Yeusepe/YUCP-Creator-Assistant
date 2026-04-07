import { Chip } from '@heroui/react';

export type ConnectionStatus = 'active' | 'degraded' | 'disconnected' | 'pending';

const STATUS_MAP: Record<
  ConnectionStatus,
  { color: 'success' | 'warning' | 'default' | 'accent'; variant: 'soft'; label: string }
> = {
  active: { color: 'success', variant: 'soft', label: 'Connected' },
  degraded: { color: 'warning', variant: 'soft', label: 'Needs attention' },
  disconnected: { color: 'default', variant: 'soft', label: 'Not connected' },
  pending: { color: 'accent', variant: 'soft', label: 'Connecting...' },
};

interface StatusChipProps {
  status: ConnectionStatus;
  /** Override the default label */
  label?: string;
  className?: string;
}

export function StatusChip({ status, label, className }: StatusChipProps) {
  const { color, variant, label: defaultLabel } = STATUS_MAP[status];
  return (
    <Chip color={color} variant={variant} size="sm" className={`rounded-full ${className ?? ''}`}>
      {label ?? defaultLabel}
    </Chip>
  );
}
