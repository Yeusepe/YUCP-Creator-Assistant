import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    success: vi.fn(),
  })),
}));

vi.mock('@/lib/dashboard', () => ({
  getCreatorIdentity: vi.fn(),
  updateCreatorIdentity: vi.fn(),
}));

import { CreatorIdentitySettingsCard } from '@/components/account/CreatorIdentitySettingsCard';
import * as dashboardApi from '@/lib/dashboard';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('account creator identity settings', () => {
  beforeEach(() => {
    vi.mocked(dashboardApi.getCreatorIdentity).mockResolvedValue({
      deliverySlug: 'creator-10705330',
      name: 'Creator 10705330',
      privateVpmHostname: 'creator-10705330.private.yucp.club',
      publicSlug: 'creator-10705330',
    });
    vi.mocked(dashboardApi.updateCreatorIdentity).mockResolvedValue({
      deliverySlug: 'yeusepe-private',
      name: 'Yeusepe',
      privateVpmHostname: 'yeusepe-private.private.yucp.club',
      publicSlug: 'yeusepe',
    });
  });

  it('edits the account-level creator name and owned URL namespaces', async () => {
    render(<CreatorIdentitySettingsCard />, { wrapper: createWrapper() });

    const nameInput = await screen.findByDisplayValue('Creator 10705330');
    expect(nameInput).toHaveAccessibleName('Creator display name');
    expect(screen.getByRole('textbox', { name: 'Public creator handle' })).toHaveValue(
      'creator-10705330'
    );
    expect(screen.getByRole('textbox', { name: 'Private VPM subdomain' })).toHaveValue(
      'creator-10705330'
    );

    fireEvent.change(nameInput, { target: { value: 'Yeusepe' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Public creator handle' }), {
      target: { value: 'yeusepe' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private VPM subdomain' }), {
      target: { value: 'yeusepe-private' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save creator identity' }));

    await waitFor(() =>
      expect(dashboardApi.updateCreatorIdentity).toHaveBeenCalledWith({
        deliverySlug: 'yeusepe-private',
        name: 'Yeusepe',
        publicSlug: 'yeusepe',
      })
    );
  });
});
