import { useQuery } from '@tanstack/react-query';
import { ApiError, apiClient } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { dashboardPanelQueryOptions } from '@/lib/dashboardQueryOptions';

export type BrandIconKey = 'assistant' | 'bag' | 'mainLogo';

export interface ViewerBranding {
  isPlus: boolean;
  billingStatus: string | null;
}

export const VIEWER_BRANDING_QUERY_KEY = ['viewer-branding'] as const;

const DEFAULT_VIEWER_BRANDING: ViewerBranding = {
  isPlus: false,
  billingStatus: null,
};

const ICON_PATHS: Record<BrandIconKey, { default: string; plus: string }> = {
  assistant: {
    default: '/Icons/Assistant.png',
    plus: '/Icons/AssistantPlus.png',
  },
  bag: {
    default: '/Icons/Bag.png',
    plus: '/Icons/BagPlus.png',
  },
  mainLogo: {
    default: '/Icons/MainLogo.png',
    plus: '/Icons/MainLogoPlus.png',
  },
};

export function isPlusBrandingActive(status: string | null | undefined): boolean {
  return status === 'active' || status === 'grace';
}

export function getBrandedIconPath(icon: BrandIconKey, isPlus: boolean): string {
  const paths = ICON_PATHS[icon];
  return isPlus ? paths.plus : paths.default;
}

async function fetchViewerBranding(): Promise<ViewerBranding> {
  try {
    const data = await apiClient.get<Partial<ViewerBranding>>('/api/connect/branding');
    const billingStatus =
      typeof data.billingStatus === 'string' && data.billingStatus.length > 0
        ? data.billingStatus
        : null;
    const isPlus =
      typeof data.isPlus === 'boolean' ? data.isPlus : isPlusBrandingActive(billingStatus);
    return { isPlus, billingStatus };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return DEFAULT_VIEWER_BRANDING;
    }
    throw error;
  }
}

export function useViewerBranding() {
  const { isAuthenticated, isPending } = useAuth();
  const brandingQuery = useQuery(
    dashboardPanelQueryOptions<ViewerBranding>({
      queryKey: VIEWER_BRANDING_QUERY_KEY,
      queryFn: fetchViewerBranding,
      enabled: !isPending && isAuthenticated,
    })
  );

  const branding = brandingQuery.data ?? DEFAULT_VIEWER_BRANDING;

  return {
    ...branding,
    mainLogoSrc: getBrandedIconPath('mainLogo', branding.isPlus),
    bagSrc: getBrandedIconPath('bag', branding.isPlus),
    assistantSrc: getBrandedIconPath('assistant', branding.isPlus),
  };
}
