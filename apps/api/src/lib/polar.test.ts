import { afterEach, describe, expect, it, mock } from 'bun:test';

let getExternalImpl: (args: { externalId: string }) => Promise<unknown> = async () => {
  throw Object.assign(new Error('missing customer'), { name: 'ResourceNotFound' });
};
let listImpl: (args: { email?: string; limit?: number }) => Promise<AsyncIterable<unknown>> =
  async () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield { result: { items: [] } };
      },
    }) satisfies AsyncIterable<unknown>;
let createImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({
  id: 'cust_created',
});
let createSessionImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({
  customerPortalUrl: 'https://polar.example.test/portal',
});

mock.module('@polar-sh/sdk', () => ({
  Polar: class PolarMock {
    customers = {
      getExternal: (args: { externalId: string }) => getExternalImpl(args),
      list: (args: { email?: string; limit?: number }) => listImpl(args),
      create: (args: Record<string, unknown>) => createImpl(args),
    };

    customerSessions = {
      create: (args: Record<string, unknown>) => createSessionImpl(args),
    };
  },
}));

mock.module('../../../../convex/lib/certificateBillingConfig', () => ({
  getCertificateBillingConfig: () => ({
    enabled: true,
    polarAccessToken: 'polar-access-token',
    polarWebhookSecret: 'polar-webhook-secret',
    polarServer: 'sandbox',
  }),
}));

const { createCertificateBillingPortalSession, PolarNoCustomerError } = await import('./polar');

afterEach(() => {
  getExternalImpl = async () => {
    throw Object.assign(new Error('missing customer'), { name: 'ResourceNotFound' });
  };
  listImpl = async () =>
    ({
      async *[Symbol.asyncIterator]() {
        yield { result: { items: [] } };
      },
    }) satisfies AsyncIterable<unknown>;
  createImpl = async () => ({ id: 'cust_created' });
  createSessionImpl = async () => ({
    customerPortalUrl: 'https://polar.example.test/portal',
  });
});

describe('createCertificateBillingPortalSession', () => {
  it('reuses an existing Polar customer found by email when external_id is missing', async () => {
    const createdCustomers: Array<Record<string, unknown>> = [];
    const createdSessions: Array<Record<string, unknown>> = [];

    listImpl = async (args) => {
      expect(args).toEqual({
        email: 'creator@example.com',
        limit: 1,
      });

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            result: {
              items: [
                {
                  id: 'cust_existing',
                  email: 'creator@example.com',
                },
              ],
            },
          };
        },
      } satisfies AsyncIterable<unknown>;
    };

    createImpl = async (args) => {
      createdCustomers.push(args);
      return { id: 'cust_created' };
    };

    createSessionImpl = async (args) => {
      createdSessions.push(args);
      return { customerPortalUrl: 'https://polar.example.test/portal/existing' };
    };

    const result = await createCertificateBillingPortalSession({
      externalCustomerId: 'auth-user-123',
      customerEmail: 'creator@example.com',
      customerName: 'Creator Example',
    });

    expect(result).toEqual({
      customerPortalUrl: 'https://polar.example.test/portal/existing',
    });
    expect(createdCustomers).toEqual([]);
    expect(createdSessions).toEqual([{ customerId: 'cust_existing' }]);
  });

  it('creates a Polar customer before creating a portal session when none exists yet', async () => {
    const createdCustomers: Array<Record<string, unknown>> = [];
    const createdSessions: Array<Record<string, unknown>> = [];

    createImpl = async (args) => {
      createdCustomers.push(args);
      return { id: 'cust_created' };
    };

    createSessionImpl = async (args) => {
      createdSessions.push(args);
      return { customerPortalUrl: 'https://polar.example.test/portal/created' };
    };

    const result = await createCertificateBillingPortalSession({
      externalCustomerId: 'auth-user-456',
      customerEmail: 'new@example.com',
      customerName: 'New Customer',
    });

    expect(result).toEqual({
      customerPortalUrl: 'https://polar.example.test/portal/created',
    });
    expect(createdCustomers).toEqual([
      {
        email: 'new@example.com',
        externalId: 'auth-user-456',
        metadata: {
          certificate_billing: true,
          yucp_user_id: 'auth-user-456',
        },
        name: 'New Customer',
      },
    ]);
    expect(createdSessions).toEqual([{ customerId: 'cust_created' }]);
  });

  it('never looks up or creates a Polar customer with a synthetic .invalid email', async () => {
    const createdCustomers: Array<Record<string, unknown>> = [];
    let listCalls = 0;

    listImpl = async () => {
      listCalls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          yield { result: { items: [] } };
        },
      } satisfies AsyncIterable<unknown>;
    };
    createImpl = async (args) => {
      createdCustomers.push(args);
      return { id: 'cust_created' };
    };

    await expect(
      createCertificateBillingPortalSession({
        externalCustomerId: 'auth-user-789',
        customerEmail: '123456789012345678@discord.invalid',
        customerName: 'Emailless Discord User',
      })
    ).rejects.toBeInstanceOf(PolarNoCustomerError);

    expect(listCalls).toBe(0);
    expect(createdCustomers).toEqual([]);
  });

  it('still resolves synthetic-email users who already have a customer by external id', async () => {
    const createdSessions: Array<Record<string, unknown>> = [];

    getExternalImpl = async (args) => {
      expect(args).toEqual({ externalId: 'auth-user-789' });
      return { id: 'cust_by_external' };
    };
    createSessionImpl = async (args) => {
      createdSessions.push(args);
      return { customerPortalUrl: 'https://polar.example.test/portal/external' };
    };

    const result = await createCertificateBillingPortalSession({
      externalCustomerId: 'auth-user-789',
      customerEmail: '123456789012345678@discord.invalid',
      customerName: 'Emailless Discord User',
    });

    expect(result).toEqual({
      customerPortalUrl: 'https://polar.example.test/portal/external',
    });
    expect(createdSessions).toEqual([{ customerId: 'cust_by_external' }]);
  });
});
