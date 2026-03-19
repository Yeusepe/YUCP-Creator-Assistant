import { describe, expect, it } from 'vitest';
import { routeStylesheetLinks } from '@/lib/routeStyles';

describe('routeStylesheetLinks', () => {
  it('returns plain stylesheet link descriptors', () => {
    expect(routeStylesheetLinks('/assets/dashboard.css')).toEqual([
      {
        rel: 'stylesheet',
        href: '/assets/dashboard.css',
      },
    ]);
  });
});
