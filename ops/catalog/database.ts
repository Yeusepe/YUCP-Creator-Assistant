import postgres from 'postgres';

export type CatalogDatabase = ReturnType<typeof postgres>;

export function openCatalogDatabase(connectionString: string): CatalogDatabase {
  return postgres(connectionString);
}
