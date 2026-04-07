import { Chip } from '@heroui/react';

export type ConnectionStatus = 'active' | 'degraded' | 'disconnected' | 'pending';

/** Extended status covering both connection states and entitlement/verification states */
export type BadgeStatus =
  | ConnectionStatus
  | 'connected'
  | 'revoked'
  | 'expired'
  | 'warning'
  | 'verified';

const STATUS_MAP: Record<
  BadgeStatus,
  { color: 'success' | 'warning' | 'default' | 'accent' | 'danger'; variant: 'soft'; label: string }
> = {
  active: { color: 'success', variant: 'soft', label: 'Active' },
  degraded: { color: 'warning', variant: 'soft', label: 'Needs attention' },
  disconnected: { color: 'default', variant: 'soft', label: 'Not connected' },
  pending: { color: 'accent', variant: 'soft', label: 'Connecting...' },
  connected: { color: 'accent', variant: 'soft', label: 'Connected' },
  revoked: { color: 'danger', variant: 'soft', label: 'Revoked' },
  expired: { color: 'warning', variant: 'soft', label: 'Expired' },
  warning: { color: 'warning', variant: 'soft', label: 'Warning' },
  verified: { color: 'success', variant: 'soft', label: 'Verified' },
};

interface StatusChipProps {
  status: BadgeStatus;
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
