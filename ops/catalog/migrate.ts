import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CatalogDatabase } from './database';

const migrationsPath = fileURLToPath(new URL('./migrations/', import.meta.url));
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function runCatalogMigrations(sql: CatalogDatabase): Promise<void> {
  const migrationFiles = (await readdir(migrationsPath))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  for (const fileName of migrationFiles) {
    if (!migrationFilePattern.test(fileName)) {
      throw new Error(`Invalid catalog migration filename: ${fileName}`);
    }
  }

  await sql.begin(async (transaction) => {
    await transaction`
      CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('yucp-catalog-migrations', 0))`;

    const appliedRows = await transaction<{ filename: string }[]>`
      SELECT filename FROM catalog_schema_migrations
    `;
    const applied = new Set(appliedRows.map(({ filename }) => filename));

    for (const fileName of migrationFiles) {
      if (applied.has(fileName)) {
        continue;
      }

      const source = await readFile(new URL(`./migrations/${fileName}`, import.meta.url), 'utf8');
      await transaction.unsafe(source);
      await transaction`
        INSERT INTO catalog_schema_migrations (filename) VALUES (${fileName})
      `;
    }
  });
}
