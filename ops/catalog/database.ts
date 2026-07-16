import postgres from 'postgres';

export type CatalogDatabase = ReturnType<typeof postgres>;
export type CatalogTimestamp = Date | string;

export function toCatalogDate(value: CatalogTimestamp | null): Date | null {
  return value instanceof Date ? value : value === null ? null : new Date(value);
}

export function openCatalogDatabase(connectionString: string): CatalogDatabase {
  return postgres(connectionString);
}
