import { Chip } from '@heroui/react';

interface ProviderChipProps {
  name: string;
  className?: string;
}

export function ProviderChip({ name, className }: ProviderChipProps) {
  return (
    <Chip variant="soft" color="default" size="sm" className={`rounded-full ${className ?? ''}`}>
      {name}
    </Chip>
  );
}
