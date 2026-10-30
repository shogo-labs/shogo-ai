// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — a real cloud and a real desktop, as two processes.
 *
 * The cloud is `apps/api/src/entry.ts` in cloud mode on a throwaway Postgres
 * database and a real Redis. The desktop is the same entrypoint in local mode on
 * its own SQLite file and data dir, paired through `cli/login` exactly like
 * `e2e/staging/machine-pairing.ts` pairs one to staging (that helper is reused
 * as-is, so a change to pairing breaks both). Nothing in the relay path is
 * stubbed: the heartbeat, the WebSocket tunnel, the machine-sync snapshot and
 * `/api/machines/:id/w/:ws/*` all run.
 *
 * The only stand-in is the model: a scripted OpenAI-compatible server, so an
 * agent turn is deterministic and costs nothing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, pairMachine, type PairedMachine } from '../../../../../e2e/staging/machine-pairing'

export const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const PG_SETUP_SCRIPT = resolve(import.meta.dir, 'pg-test-db.ts')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface CloudProcess {
  base: string
  log: string[]
  dbUrl: string
  stop: () => Promise<void>
}

/** Env with `undefined` meaning "unset", so the ambient shell cannot leak in. */
function processEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...overrides })) if (v !== undefined) out[k] = v
  return out
}

/**
 * The cloud API, started the way a pod starts it (`entry.ts`, not a hand-built
 * Hono app): every route, middleware and WebSocket upgrade it serves in
 * production.
 */
export async function startCloud(opts: { pgServerUrl: string; redisUrl: string }): Promise<CloudProcess> {
  const dbName = `shogo_vm_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const created = spawnSync(process.execPath, [PG_SETUP_SCRIPT, 'create', opts.pgServerUrl, dbName], {
    encoding: 'utf-8',
  })
  if (created.status !== 0) throw new Error(`cloud database setup failed: ${created.stderr || created.stdout}`)
  const url = new URL(opts.pgServerUrl)
  url.pathname = `/${dbName}`
  const dbUrl = url.toString()

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const dataDir = mkdtempSync(join(tmpdir(), 'shogo-vm-cloud-'))
  const log: string[] = []
  const proc: ChildProcess = spawn('bun', ['--no-env-file', 'apps/api/src/entry.ts'], {
    cwd: REPO_ROOT,
    env: processEnv({
      SHOGO_LOCAL_MODE: undefined,
      SHOGO_APP_DATABASE_URL: dbUrl,
      DATABASE_URL: dbUrl,
      REDIS_URL: opts.redisUrl,
      API_PORT: String(port),
      PORT: String(port),
      NODE_ENV: 'development',
      BETTER_AUTH_SECRET: 'sho257-two-process-secret-0123456789abcdef',
      BETTER_AUTH_URL: base,
      APP_URL: base,
      WORKSPACES_DIR: join(dataDir, 'workspaces'),
      SHOGO_DATA_DIR: dataDir,
      HOSTNAME: `vm-cloud-${port}`,
      // The cloud is not a desktop and must never reap another Shogo's runtimes.
      SHOGO_SKIP_STALE_RUNTIME_CLEANUP: '1',
      SHOGO_CLOUD_URL: undefined,
      SHOGO_API_KEY: undefined,
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', (b) => log.push(b.toString()))
  proc.stderr?.on('data', (b) => log.push(b.toString()))

  const stop = async () => {
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGTERM')
      await Promise.race([exited, sleep(5000)])
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
    spawnSync(process.execPath, [PG_SETUP_SCRIPT, 'drop', opts.pgServerUrl, dbName], { encoding: 'utf-8' })
    rmSync(dataDir, { recursive: true, force: true })
  }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return { base, log, dbUrl, stop }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  await stop()
  throw new Error(`the cloud API never came up:\n${log.join('').slice(-3000)}`)
}

export { pairMachine, type PairedMachine }

export {
  httpClient,
  machineViewClient,
  read,
  sessionUserId,
  signUp,
  waitFor,
  type Session,
} from './machine-vm-clients'
