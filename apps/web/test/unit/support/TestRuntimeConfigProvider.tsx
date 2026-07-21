import type { PropsWithChildren } from 'react';
import { RuntimeConfigProvider } from '@/lib/runtimeConfig';

export function TestRuntimeConfigProvider({ children }: PropsWithChildren) {
  return (
    <RuntimeConfigProvider
      value={{
        automaticSetupEnabled: false,
        browserAuthBaseUrl: 'https://app.example.com',
        buildId: 'test-build',
        privateVpmEnabled: false,
      }}
    >
      {children}
    </RuntimeConfigProvider>
  );
}
