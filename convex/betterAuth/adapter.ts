import { createApi } from '@convex-dev/better-auth';
import { createSchemaAuthOptions } from './options';
import schema from './schema';

const adapterApi = createApi(schema, createSchemaAuthOptions);

export const create = adapterApi.create;
export const findOne = adapterApi.findOne;
export const findMany = adapterApi.findMany;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateOne = adapterApi.updateOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateMany = adapterApi.updateMany as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteOne = adapterApi.deleteOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteMany = adapterApi.deleteMany as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const consumeOne = adapterApi.consumeOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const incrementOne = adapterApi.incrementOne as any;
