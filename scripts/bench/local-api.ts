// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Boot THIS checkout's API in desktop local mode against a scratch data
 * directory, so `bun run bench:open` can measure the working tree instead of
 * whichever packaged Shogo happens to be installed.
 *
 *   bun run bench:local-api                      # data in <tmp>/shogo-bench/data, port 39200
 *   bun run bench:local-api --reset              # wipe the scratch data dir first
 *   bun run bench:local-api --port 39300 --pool-size 2
 *   bun run bench:local-api --env HOST_POOL_MAX_ASSIGNED=4 --env SHOGO_WINDOWS_INSTALL_BACKEND=bun
 *
 * Mirrors the environment `apps/desktop/src/local-server.ts` builds for the
 * Electron shell (SQLite DB, workspaces dir, runtime template, warm pool,
 * agent-runtime entry) with dev paths: the API runs from `apps/api/src`, the
 * agent-runtime from `packages/agent-runtime/src`. Ports for the API, the
 * RuntimeManager range, and the host pool range are offset from the desktop
 * defaults so this can run beside an installed Shogo.
 *
 * The process stays in the foreground and forwards API output; Ctrl-C tears
 * down the API and every runtime it spawned. Logs also go to
 * `<data-dir>/api.log` for `bun run bench:waterfall`.
 */
import { spawn, execSync } from 'child_process'
import { randomBytes } from 'crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir, tmpdir, totalmem } from 'os'

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const multiArg = (name: string): string[] => {
  const out: string[] = []
  process.argv.forEach((value, i) => { if (value === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]) })
  return out
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const dataDir = resolve(arg('data-dir') || join(tmpdir(), 'shogo-bench', 'data'))
const port = Number(arg('port', '39200'))
const poolSize = Number(arg('pool-size', '1'))
const reset = process.argv.includes('--reset')
const extraEnv = Object.fromEntries(multiArg('env').map((kv) => {
  const idx = kv.indexOf('=')
  return idx > 0 ? [kv.slice(0, idx), kv.slice(idx + 1)] : [kv, '1']
}))

const isWindows = process.platform === 'win32'
const bunPath = process.execPath
const workspacesDir = join(dataDir, 'workspaces')
const dbPath = join(dataDir, 'shogo.db')
const logPath = join(dataDir, 'api.log')

if (reset && existsSync(dataDir)) {
  console.log(`[bench-api] resetting ${dataDir}`)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
}
mkdirSync(workspacesDir, { recursive: true })

// Runtime template (what the desktop copies from resources/runtime-template).
const templateDest = join(workspacesDir, '_template')
const templateSrc = join(repoRoot, 'templates', 'runtime-template')
if (!existsSync(join(templateDest, 'package.json'))) {
  if (!existsSync(templateSrc)) throw new Error(`runtime template missing at ${templateSrc}`)
  console.log(`[bench-api] copying runtime template -> ${templateDest}`)
  cpSync(templateSrc, templateDest, {
    recursive: true,
    filter: (src: string) => !src.split(/[\\/]+/).some((s) => s === 'node_modules' || s === '.git'),
  })
}

// Auth secret, persisted so sessions survive restarts of this script.
const secretPath = join(dataDir, '.auth-secret')
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('base64'))
const authSecret = readFileSync(secretPath, 'utf8').trim()

// Database: empty file + `prisma migrate deploy` on the SQLite track.
if (!existsSync(dbPath)) {
  console.log('[bench-api] creating SQLite database and applying migrations')
  writeFileSync(dbPath, '')
}
const migrateEnv = { ...process.env, DATABASE_URL: `file:${dbPath}` }
delete migrateEnv.SHOGO_APP_DATABASE_URL
const migrateOut = execSync(`"${bunPath}" x prisma migrate deploy --config=prisma.config.local.ts`, {
  cwd: repoRoot,
  env: migrateEnv,
  stdio: 'pipe',
  encoding: 'utf8',
  timeout: 120_000,
})
console.log(`[bench-api] migrations: ${migrateOut.trim().split('\n').pop()}`)

const totalMemMB = Math.round(totalmem() / 1024 / 1024)
const memoryMB = Math.min(8192, Math.max(3072, Math.floor(totalMemMB * 0.4)))

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: `${dirname(bunPath)}${isWindows ? ';' : ':'}${process.env.PATH || ''}`,
  HOME: process.env.HOME || process.env.USERPROFILE || homedir(),
  SHOGO_LOCAL_MODE: 'true',
  APP_VERSION: 'bench-dev',
  SHOGO_APP_DATABASE_URL: `file:${dbPath}`,
  WORKSPACES_DIR: workspacesDir,
  S3_ENABLED: 'false',
  API_PORT: String(port),
  PORT: String(port),
  // Desktop uses 39110 / 38300–38900; stay clear of an installed app.
  RUNTIME_BASE_PORT: String(port + 110),
  HOST_POOL_PORT_BASE: String(port + 300),
  HOST_POOL_PORT_END: String(port + 900),
  NODE_ENV: 'development',
  BETTER_AUTH_SECRET: authSecret,
  BETTER_AUTH_URL: `http://localhost:${port}`,
  BUN_INSTALL_CACHE_DIR: join(dataDir, '.bun-cache'),
  SHOGO_BUN_PATH: bunPath,
  SHOGO_BUNDLED_SDK_CLI: join(repoRoot, 'packages', 'sdk', 'bin', 'cli.mjs'),
  AGENT_RUNTIME_ENTRY: join(repoRoot, 'packages', 'agent-runtime', 'src', 'server.ts'),
  CANVAS_RUNTIME_DIST: join(repoRoot, 'packages', 'canvas-runtime', 'dist'),
  CANVAS_GLOBALS_DTS: join(repoRoot, 'packages', 'canvas-runtime', 'src', 'canvas-globals.d.ts'),
  SHOGO_DATA_DIR: dataDir,
  SHOGO_SHERPA_DIR: join(dataDir, 'sherpa-onnx'),
  RUNTIME_MEMORY_MB: String(memoryMB),
  RUNTIME_CPU_PERCENT: '0',
  HOST_WARM_POOL_SIZE: String(poolSize),
  SHOGO_PERF_LOG: '1',
  ...extraEnv,
}
delete env.DATABASE_URL
delete env.PROJECTS_DATABASE_URL

console.log(`[bench-api] starting API on :${port} (pool ${poolSize}, data ${dataDir})`)
const child = spawn(bunPath, ['--no-env-file', '--conditions=development', join('apps', 'api', 'src', 'entry.ts')], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const log = Bun.file(logPath).writer()
const forward = (prefix: string) => (chunk: Buffer) => {
  const text = chunk.toString()
  log.write(`${text.endsWith('\n') ? text : text + '\n'}`)
  process.stdout.write(text.split('\n').filter(Boolean).map((l) => `${prefix} ${l}\n`).join(''))
}
child.stdout?.on('data', forward('[API]'))
child.stderr?.on('data', forward('[API]'))

function shutdown(): void {
  if (!child.pid) return
  console.log('\n[bench-api] stopping API')
  if (isWindows) {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'pipe' }) } catch { /* gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
  }
}
process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })
child.on('exit', (code) => {
  console.log(`[bench-api] API exited (code=${code})`)
  process.exit(code ?? 1)
})

// Ready banner with the ids the harness needs for `--scenario new`.
;(async () => {
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 240; i++) {
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (health.ok) break
    } catch { /* not yet */ }
    await Bun.sleep(500)
  }
  for (let i = 0; i < 60; i++) {
    try {
      const signIn = await fetch(`${base}/api/local/auto-sign-in`, { method: 'POST' })
      if (signIn.ok) {
        const cookie = (signIn.headers.getSetCookie?.() ?? [signIn.headers.get('set-cookie') || ''])
          .map((v) => v.split(';', 1)[0]).filter(Boolean).join('; ')
        const me = await fetch(`${base}/api/me`, { headers: { cookie } }).then((r) => r.json()) as any
        const ws = await fetch(`${base}/api/workspaces`, { headers: { cookie } }).then((r) => r.json()) as any
        const workspaceId = ws?.items?.[0]?.id ?? ws?.data?.[0]?.id ?? (Array.isArray(ws) ? ws[0]?.id : undefined)
        console.log(
          `\n[bench-api] READY ${base}\n` +
          `[bench-api]   user-id      ${me?.data?.id}\n` +
          `[bench-api]   workspace-id ${workspaceId}\n` +
          `[bench-api]   bun run bench:open --api-url ${base} --workspaces-dir "${workspacesDir}" ` +
          `--scenario new --cleanup --runs 3 --workspace-id ${workspaceId} --user-id ${me?.data?.id}\n`,
        )
        return
      }
    } catch { /* user not seeded yet */ }
    await Bun.sleep(500)
  }
  console.warn('[bench-api] API is up but auto-sign-in never succeeded; check api.log')
})()
