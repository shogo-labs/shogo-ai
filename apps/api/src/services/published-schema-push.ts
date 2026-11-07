// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Push an app's schema, and its seed rows, to its published database (SHO-308 §1).
 *
 * Runs in the API, inside the cluster, because that is where `projects-pg` is
 * reachable. The project's runtime only exports the Postgres schema and the seed
 * SQL (`/agent/published-schema` mode `export`): a runtime can live on a host
 * outside the cluster network (a metal VM), and the database credential should
 * never enter a sandbox that runs user code.
 *
 * Both steps use the Prisma CLI the API already ships, from a fresh temp
 * directory holding only the schema and a config that reads the URL from the
 * child's environment. Nothing in the API's own directory (its `prisma.config.ts`,
 * its `DATABASE_URL`) can be picked up, so a push can only ever reach the
 * database it was given.
 *
 * The push targets the *direct* connection, never the PgBouncer pooler: DDL in
 * transaction mode can land on different backends, and Prisma takes session
 * locks while it runs.
 */

import { spawn } from '@shogo/shared-runtime/child-process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

/** How long a schema push or seed load may take before the publish gives up. */
const PUSH_TIMEOUT_MS = 120_000

export interface PushPublishedSchemaInput {
  /** Postgres-provider schema text, as exported by the runtime. */
  schema: string
  /** Seed SQL from the runtime, or null to push the schema only. */
  seedSql: string | null
  /** Direct (non-pooled) Postgres URL. */
  databaseUrl: string
}

export type PushPublishedSchemaResult =
  | { ok: true }
  | { ok: false; code: 'schema_push_failed' | 'seed_failed'; message: string }

/** Absolute path of the Prisma CLI entry point the API depends on. */
export function resolvePrismaCli(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js')
}

/**
 * The config Prisma 7 needs to find the schema and the connection string. It
 * imports nothing, so it loads from a temp directory with no `node_modules`.
 */
export const PUSH_CONFIG = [
  `export default {`,
  `  schema: './schema.prisma',`,
  `  datasource: { url: process.env.PUBLISHED_DATABASE_URL },`,
  `}`,
  ``,
].join('\n')

/**
 * The child's environment: the API's own, minus every variable Prisma could read
 * a connection string from, plus the published one.
 */
export function pushEnv(databaseUrl: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of Object.keys(env)) {
    if (/(DATABASE|DB)_(ADMIN_)?URL$|^DIRECT_URL$|^PRISMA_/.test(key)) delete env[key]
  }
  env.PUBLISHED_DATABASE_URL = databaseUrl
  env.CHECKPOINT_DISABLE = '1'
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1'
  return env
}

export async function pushPublishedSchema(
  input: PushPublishedSchemaInput,
  deps: { runPrisma?: typeof runPrisma } = {},
): Promise<PushPublishedSchemaResult> {
  const run = deps.runPrisma ?? runPrisma
  const workDir = mkdtempSync(join(tmpdir(), 'shogo-published-schema-'))
  const configPath = join(workDir, 'prisma.config.ts')
  const env = pushEnv(input.databaseUrl)
  try {
    writeFileSync(join(workDir, 'schema.prisma'), input.schema, 'utf-8')
    writeFileSync(configPath, PUSH_CONFIG, 'utf-8')

    // Prisma 7 has no `--skip-generate` on `db push` and no `--schema` on
    // `db execute`; either flag makes the command print its help and exit 1.
    try {
      await run(['db', 'push', '--config', configPath], workDir, env)
    } catch (err: any) {
      return {
        ok: false,
        code: 'schema_push_failed',
        message: `Could not apply the schema to the published database: ${tailLines(String(err?.message ?? err), 6)}`,
      }
    }

    if (input.seedSql) {
      const sqlPath = join(workDir, 'seed.sql')
      writeFileSync(sqlPath, input.seedSql, 'utf-8')
      try {
        await run(['db', 'execute', '--config', configPath, '--file', sqlPath], workDir, env)
      } catch (err: any) {
        return {
          ok: false,
          code: 'seed_failed',
          message: `Schema applied, but the seed data did not load: ${tailLines(String(err?.message ?? err), 6)}`,
        }
      }
    }
    return { ok: true }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Run the Prisma CLI with the API's own runtime; rejects with its output on a non-zero exit. */
export function runPrisma(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const cli = resolvePrismaCli()
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already exited */ }
      rejectPromise(new Error(`prisma ${args[0]} ${args[1]} timed out after ${PUSH_TIMEOUT_MS}ms`))
    }, PUSH_TIMEOUT_MS)
    proc.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(stderr.trim() || stdout.trim() || `exit ${code}`))
    })
  })
}

/** The useful end of a Prisma CLI error, for the publish error message. */
function tailLines(text: string, lines: number): string {
  const split = text.trim().split('\n').filter(Boolean)
  return split.slice(-lines).join(' ').slice(0, 600)
}
