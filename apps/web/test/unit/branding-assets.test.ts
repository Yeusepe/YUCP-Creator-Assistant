import { describe, expect, it } from 'vitest';
import { getBrandedIconPath, isPlusBrandingActive } from '@/lib/brandingAssets';

describe('branding asset helpers', () => {
  it('uses plus icons for active or grace certificate billing states', () => {
    expect(isPlusBrandingActive('active')).toBe(true);
    expect(isPlusBrandingActive('grace')).toBe(true);
    expect(isPlusBrandingActive('inactive')).toBe(false);
    expect(isPlusBrandingActive('suspended')).toBe(false);
    expect(isPlusBrandingActive(null)).toBe(false);
  });

  it('resolves plus and standard icon paths from the same helper', () => {
    expect(getBrandedIconPath('mainLogo', true)).toBe('/Icons/MainLogoPlus.png');
    expect(getBrandedIconPath('bag', true)).toBe('/Icons/BagPlus.png');
    expect(getBrandedIconPath('assistant', true)).toBe('/Icons/AssistantPlus.png');
    expect(getBrandedIconPath('mainLogo', false)).toBe('/Icons/MainLogo.png');
  });
});
