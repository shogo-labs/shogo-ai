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
import { HttpClient } from '@shogo-ai/sdk'
import {
  createRemoteAwareHttpClient,
  type RemoteInterceptorConfig,
} from '../../../../../packages/shared-app/src/services/remote-http-interceptor'
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

/** A cookie-carrying session against one API, the way the app holds one. */
export interface Session {
  base: string
  cookie: string
  userId: string
}

export async function signUp(base: string, label: string): Promise<Session> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${label}-${suffix}@shogo.test`, password: `Shogo-257-${suffix}-pw`, name: label }),
  })
  if (!res.ok) throw new Error(`sign-up failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const json: any = await res.json()
  return { base, cookie, userId: json?.user?.id }
}

export async function sessionUserId(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/get-session`, { headers: { cookie, origin: base } })
  const json: any = await res.json().catch(() => null)
  return json?.user?.id ?? json?.session?.userId
}

/** The SDK's own HTTP client, holding a session cookie. */
export function httpClient(base: string, cookie: string): HttpClient {
  return new HttpClient({ baseUrl: base, getToken: () => null, getAuthCookie: () => cookie })
}

/**
 * The client the cloud app uses while a paired machine's workspace is open:
 * the production interceptor (`createRemoteAwareHttpClient`) wrapping the SDK
 * client, configured exactly as `useActiveInstance` configures it. Every read
 * and write the suite makes through it is routed by the product's own rules —
 * copy for reads, the relay for writes and live reads.
 */
export function machineViewClient(cloud: Session, machineId: string, localWorkspaceId: string): HttpClient {
  const config: RemoteInterceptorConfig = {
    remoteProxyBaseUrl: `${cloud.base}/api/machines/${machineId}/w/${localWorkspaceId}`,
    machineWorkspaceId: localWorkspaceId,
  }
  return createRemoteAwareHttpClient(httpClient(cloud.base, cloud.cookie), () => config)
}

/** GET and return `{ status, data }` without throwing, so a failure names its surface. */
export async function read(client: HttpClient, path: string): Promise<{ status: number; data: any; error?: string }> {
  try {
    const res: any = await client.get(path)
    return { status: res.status ?? 200, data: res.data }
  } catch (err: any) {
    return { status: err?.status ?? 0, data: err?.details ?? null, error: err?.message ?? String(err) }
  }
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
