import { afterEach, describe, expect, it } from 'bun:test';
import { getGumroadProviderRuntimeConfig, getJinxxyProviderRuntimeConfig } from './runtimeConfig';

const originalGumroadClientId = process.env.GUMROAD_CLIENT_ID;
const originalGumroadClientSecret = process.env.GUMROAD_CLIENT_SECRET;
const originalJinxxyApiBaseUrl = process.env.JINXXY_API_BASE_URL;

afterEach(() => {
  if (originalGumroadClientId === undefined) {
    delete process.env.GUMROAD_CLIENT_ID;
  } else {
    process.env.GUMROAD_CLIENT_ID = originalGumroadClientId;
  }

  if (originalGumroadClientSecret === undefined) {
    delete process.env.GUMROAD_CLIENT_SECRET;
  } else {
    process.env.GUMROAD_CLIENT_SECRET = originalGumroadClientSecret;
  }

  if (originalJinxxyApiBaseUrl === undefined) {
    delete process.env.JINXXY_API_BASE_URL;
  } else {
    process.env.JINXXY_API_BASE_URL = originalJinxxyApiBaseUrl;
  }
});

describe('provider runtime config', () => {
  it('reads Gumroad runtime config from the centralized env loader', () => {
    process.env.GUMROAD_CLIENT_ID = 'gumroad-client-id';
    process.env.GUMROAD_CLIENT_SECRET = 'gumroad-client-secret';

    expect(getGumroadProviderRuntimeConfig()).toEqual({
      clientId: 'gumroad-client-id',
      clientSecret: 'gumroad-client-secret',
      redirectUri: '',
    });
  });

  it('reads Jinxxy runtime config from the centralized env loader', () => {
    process.env.JINXXY_API_BASE_URL = 'https://api.jinxxy.test';

    expect(getJinxxyProviderRuntimeConfig()).toEqual({
      apiBaseUrl: 'https://api.jinxxy.test',
    });
  });
});
