import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogDatabase } from './database';

const catalogMigrationsPath = fileURLToPath(new URL('./migrations/', import.meta.url));
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface CatalogMigrationOptions {
  migrationsPath?: string;
}

export async function runCatalogMigrations(
  sql: CatalogDatabase,
  options: CatalogMigrationOptions = {}
): Promise<void> {
  const migrationsPath = options.migrationsPath ?? catalogMigrationsPath;
  const migrationFiles = (await readdir(migrationsPath))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  for (const fileName of migrationFiles) {
    if (!migrationFilePattern.test(fileName)) {
      throw new Error(`Invalid catalog migration filename: ${fileName}`);
    }
  }

  const migrations = await Promise.all(
    migrationFiles.map(async (fileName) => {
      const source = await readFile(join(migrationsPath, fileName), 'utf8');
      return {
        fileName,
        source,
        checksum: createHash('sha256').update(source).digest('hex'),
      };
    })
  );
  const migrationsByFileName = new Map(
    migrations.map((migration) => [migration.fileName, migration])
  );

  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('yucp-catalog-migrations', 0))`;
    await transaction`
      CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
        filename text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
    await transaction`
      ALTER TABLE catalog_schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text
    `;
    const appliedRows = await transaction<{ filename: string; checksum: string | null }[]>`
      SELECT filename, checksum FROM catalog_schema_migrations
    `;

    for (const row of appliedRows) {
      if (row.checksum === null) {
        continue;
      }
      const migration = migrationsByFileName.get(row.filename);
      if (!migration) {
        throw new Error(`Catalog migration file missing for applied migration: ${row.filename}`);
      }
      if (row.checksum !== migration.checksum) {
        throw new Error(
          `Catalog migration checksum mismatch for ${row.filename}: applied ${row.checksum}, current ${migration.checksum}`
        );
      }
    }

    const applied = new Set(appliedRows.map(({ filename }) => filename));

    for (const migration of migrations) {
      if (applied.has(migration.fileName)) {
        continue;
      }

      await transaction.unsafe(migration.source);
      await transaction`
        INSERT INTO catalog_schema_migrations (filename, checksum)
        VALUES (${migration.fileName}, ${migration.checksum})
      `;
    }
  });
}
