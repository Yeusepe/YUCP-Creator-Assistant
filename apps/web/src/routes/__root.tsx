/// <reference types="vite/client" />

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import {
  getPublicRuntimeConfig,
  RuntimeConfigProvider,
  serializePublicRuntimeConfig,
  type PublicRuntimeConfig,
} from '@/lib/runtimeConfig';

import '@/styles/tokens.css';
import '@/styles/loading.css';
import '@/styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

export const Route = createRootRoute({
  loader: () => getPublicRuntimeConfig(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Creator Assistant' },
      {
        name: 'description',
        content:
          'Manage your Discord server integrations, verification, and creator tools with Creator Assistant.',
      },
    ],
    links: [
      { rel: 'icon', href: '/Icons/favicon.ico', type: 'image/x-icon' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap',
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const runtimeConfig = Route.useLoaderData();
  return (
    <RootDocument runtimeConfig={runtimeConfig}>
      <RuntimeConfigProvider value={runtimeConfig}>
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
      </RuntimeConfigProvider>
    </RootDocument>
  );
}

function RootDocument({
  children,
  runtimeConfig,
}: Readonly<{ children: ReactNode; runtimeConfig: PublicRuntimeConfig }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          id="public-runtime-config"
          dangerouslySetInnerHTML={{
            __html: `window.__YUCP_PUBLIC_RUNTIME_CONFIG__=${serializePublicRuntimeConfig(runtimeConfig)};`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
