import { createApi } from '@convex-dev/better-auth';
import { createSchemaAuthOptions } from './options';
import schema from './schema';

const api = createApi(schema, createSchemaAuthOptions);

export const create = api.create;
export const findOne = api.findOne;
export const findMany = api.findMany;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateOne = api.updateOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateMany = api.updateMany as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteOne = api.deleteOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteMany = api.deleteMany as any;
