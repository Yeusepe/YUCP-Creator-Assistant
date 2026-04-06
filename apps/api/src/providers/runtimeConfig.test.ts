import { afterEach, describe, expect, it } from 'bun:test';
import { getJinxxyProviderRuntimeConfig } from './runtimeConfig';

const originalJinxxyApiBaseUrl = process.env.JINXXY_API_BASE_URL;

afterEach(() => {
  if (originalJinxxyApiBaseUrl === undefined) {
    delete process.env.JINXXY_API_BASE_URL;
  } else {
    process.env.JINXXY_API_BASE_URL = originalJinxxyApiBaseUrl;
  }
});

describe('provider runtime config', () => {
  it('reads Jinxxy runtime config from the centralized env loader', () => {
    process.env.JINXXY_API_BASE_URL = 'https://api.jinxxy.test';

    expect(getJinxxyProviderRuntimeConfig()).toEqual({
      apiBaseUrl: 'https://api.jinxxy.test',
    });
  });
});
