export type BrandIconKey = 'assistant' | 'bag' | 'mainLogo';

export interface ViewerBranding {
  isPlus: boolean;
  billingStatus: string | null;
}

export const VIEWER_BRANDING_QUERY_KEY = ['viewer-branding'] as const;

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
