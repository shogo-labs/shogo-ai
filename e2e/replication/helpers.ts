/**
 * Shared helpers for multi-region replication integration tests.
 *
 * Environment variables:
 *   DB_URL_US     — PostgreSQL connection string for the US region (required)
 *   DB_URL_EU     — PostgreSQL connection string for the EU region (required)
 *   DB_URL_INDIA  — PostgreSQL connection string for the India region (required)
 *   API_URL_US    — Base URL of the US API (for session roaming tests)
 *   API_URL_EU    — Base URL of the EU API (for session roaming tests)
 *   API_URL_INDIA — Base URL of the India API (for session roaming tests)
 */
import { Pool, type PoolClient } from "pg"

export interface RegionConfig {
  name: string
  dbUrl: string
  apiUrl?: string
}

export interface TestEnv {
  us: RegionConfig
  eu: RegionConfig
  india: RegionConfig
  pools: Map<string, Pool>
}

export function getTestEnv(): TestEnv {
  const usDb = process.env.DB_URL_US
  const euDb = process.env.DB_URL_EU
  const indiaDb = process.env.DB_URL_INDIA

  if (!usDb || !euDb || !indiaDb) {
    throw new Error(
      "DB_URL_US, DB_URL_EU, and DB_URL_INDIA are all required.\n" +
        "Set them to the PostgreSQL connection strings for each region."
    )
  }

  const pools = new Map<string, Pool>()
  pools.set("us", new Pool({ connectionString: usDb, max: 3 }))
  pools.set("eu", new Pool({ connectionString: euDb, max: 3 }))
  pools.set("india", new Pool({ connectionString: indiaDb, max: 3 }))

  return {
    us: { name: "us", dbUrl: usDb, apiUrl: process.env.API_URL_US },
    eu: { name: "eu", dbUrl: euDb, apiUrl: process.env.API_URL_EU },
    india: {
      name: "india",
      dbUrl: indiaDb,
      apiUrl: process.env.API_URL_INDIA,
    },
    pools,
  }
}

export function pool(env: TestEnv, region: string): Pool {
  const p = env.pools.get(region)
  if (!p) throw new Error(`No pool for region: ${region}`)
  return p
}

/**
 * Poll the target region until a row matching the predicate appears,
 * or throw after timeoutMs.
 */
export async function waitForReplication<T>(opts: {
  sourcePool: Pool
  targetPool: Pool
  query: string
  params?: any[]
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<T> {
  const {
    targetPool,
    query,
    params = [],
    timeoutMs = 10_000,
    pollIntervalMs = 250,
  } = opts
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const result = await targetPool.query(query, params)
    if (result.rows.length > 0) {
      return result.rows[0] as T
    }
    await sleep(pollIntervalMs)
  }

  throw new Error(
    `Replication timeout after ${timeoutMs}ms. Query: ${query}, Params: ${JSON.stringify(params)}`
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function generateCuid(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 12)
  return `c${ts}${rand}`.slice(0, 25)
}

/**
 * Clean up test rows inserted during a test run, keyed by a unique marker.
 */
export async function cleanupTestRows(
  env: TestEnv,
  table: string,
  column: string,
  marker: string
): Promise<void> {
  const deleteQuery = `DELETE FROM ${table} WHERE ${column} LIKE $1`
  const pattern = `%${marker}%`
  for (const [, p] of env.pools) {
    await p.query(deleteQuery, [pattern]).catch(() => {})
  }
}

export async function closeAllPools(env: TestEnv): Promise<void> {
  for (const [, p] of env.pools) {
    await p.end().catch(() => {})
  }
}

/**
 * Query pg_stat_subscription on a given region to check subscription health.
 */
export async function getSubscriptionStatus(
  p: Pool
): Promise<
  { subname: string; pid: number | null; received_lsn: string | null }[]
> {
  const result = await p.query(
    "SELECT subname, pid, received_lsn FROM pg_stat_subscription WHERE subname LIKE 'sub_from_%'"
  )
  return result.rows
}

/**
 * Query pg_stat_subscription_stats (PG 18) for conflict counts.
 */
export async function getConflictStats(
  p: Pool
): Promise<{ subname: string; conflict_count: number }[]> {
  const result = await p.query(`
    SELECT subname,
           COALESCE(apply_error_count, 0) + COALESCE(sync_error_count, 0) as conflict_count
    FROM pg_stat_subscription_stats
    WHERE subname LIKE 'sub_from_%'
  `)
  return result.rows
}
