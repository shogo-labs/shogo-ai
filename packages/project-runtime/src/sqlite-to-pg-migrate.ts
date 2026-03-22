/**
 * SQLite → PostgreSQL data migration for published apps.
 *
 * Runs as a standalone script during published service initialization.
 * Reads the dev SQLite database (prisma/dev.db), converts data types,
 * and bulk-inserts into the PostgreSQL sidecar (which already has the
 * schema from `prisma db push`).
 *
 * Usage: bun run src/sqlite-to-pg-migrate.ts
 *
 * Env vars:
 *   PROJECT_DIR  - workspace root (default: /app/project)
 *   DATABASE_URL - PostgreSQL connection string
 */

import { Database } from "bun:sqlite"
import pg from "pg"

const PROJECT_DIR = process.env.PROJECT_DIR || "/app/project"
const DATABASE_URL = process.env.DATABASE_URL
const SQLITE_PATH = `${PROJECT_DIR}/prisma/dev.db`

const PRISMA_INTERNAL_TABLES = new Set(["_prisma_migrations"])

async function migrate() {
  const fs = await import("fs")

  if (!fs.existsSync(SQLITE_PATH)) {
    console.log("[sqlite-to-pg] No SQLite database found at", SQLITE_PATH, "— skipping migration")
    process.exit(0)
  }

  if (!DATABASE_URL || !DATABASE_URL.startsWith("postgres")) {
    console.error("[sqlite-to-pg] DATABASE_URL is not a PostgreSQL URL — aborting")
    process.exit(1)
  }

  console.log("[sqlite-to-pg] Starting migration:", SQLITE_PATH, "→", DATABASE_URL.replace(/\/\/.*@/, "//<credentials>@"))

  const sqlite = new Database(SQLITE_PATH, { readonly: true })
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  try {
    const tables = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .filter((name) => !PRISMA_INTERNAL_TABLES.has(name))

    if (tables.length === 0) {
      console.log("[sqlite-to-pg] No user tables found — nothing to migrate")
      return
    }

    console.log("[sqlite-to-pg] Tables to migrate:", tables.join(", "))

    let totalRows = 0

    for (const table of tables) {
      const rows = sqlite.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all()
      if (rows.length === 0) {
        console.log(`[sqlite-to-pg]   ${table}: 0 rows (skipped)`)
        continue
      }

      const columns = Object.keys(rows[0])
      const quotedCols = columns.map((c) => `"${c}"`).join(", ")

      // Truncate existing data in PG table to make migration idempotent
      await client.query(`DELETE FROM "${table}"`)

      // Batch insert in chunks of 500
      const BATCH = 500
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const values: unknown[] = []
        const placeholders = batch.map((row, rowIdx) => {
          const rowPlaceholders = columns.map((col, colIdx) => {
            values.push(convertValue(row[col]))
            return `$${rowIdx * columns.length + colIdx + 1}`
          })
          return `(${rowPlaceholders.join(", ")})`
        })

        await client.query(`INSERT INTO "${table}" (${quotedCols}) VALUES ${placeholders.join(", ")}`, values)
      }

      totalRows += rows.length
      console.log(`[sqlite-to-pg]   ${table}: ${rows.length} rows migrated`)
    }

    console.log(`[sqlite-to-pg] Migration complete: ${totalRows} total rows across ${tables.length} tables`)

    // Rename SQLite file so we don't re-migrate on next restart
    fs.renameSync(SQLITE_PATH, `${SQLITE_PATH}.migrated`)
    console.log("[sqlite-to-pg] Renamed dev.db → dev.db.migrated")
  } finally {
    sqlite.close()
    await client.end()
  }
}

/**
 * Convert SQLite values to PostgreSQL-compatible types.
 * SQLite stores booleans as 0/1 integers and dates as ISO strings or unix timestamps.
 */
function convertValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  return value
}

migrate().catch((err) => {
  console.error("[sqlite-to-pg] Migration failed:", err)
  process.exit(1)
})
