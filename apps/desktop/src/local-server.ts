// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawn, execSync, execFileSync, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync } from 'fs'
import path from 'path'
import { getBunPath, getDbPath, getWorkspacesDir, getProjectRoot, getDataDir } from './paths'
import { isVMAvailable } from './vm'

// Shogo-reserved port range — chosen to avoid conflicts with common dev tools
const PREFERRED_PORT = 39100
const RUNTIME_BASE_PORT = 39110
const PORT_RANGE = 100
const MAX_HEALTH_RETRIES = 60
const HEALTH_RETRY_DELAY_MS = 500
const SHUTDOWN_TIMEOUT_MS = 5000

let apiProcess: ChildProcess | null = null
let apiPort: number = PREFERRED_PORT

export function getApiPort(): number {
  return apiPort
}

export function getApiUrl(): string {
  return `http://localhost:${apiPort}`
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findFreePort(): Promise<number> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + PORT_RANGE; port++) {
    if (await checkPort(port)) return port
  }
  throw new Error(`No free port found in range ${PREFERRED_PORT}-${PREFERRED_PORT + PORT_RANGE - 1}`)
}

// --- PID file management ---

function getPidFilePath(): string {
  const { getDataDir } = require('./paths') as typeof import('./paths')
  return path.join(getDataDir(), 'api.pid')
}

function writePidFile(pid: number): void {
  const fs = require('fs') as typeof import('fs')
  const pidFile = getPidFilePath()
  fs.writeFileSync(pidFile, String(pid), { mode: 0o600 })
  console.log(`[Desktop] PID file written: ${pidFile} (pid=${pid})`)
}

function removePidFile(): void {
  const fs = require('fs') as typeof import('fs')
  const pidFile = getPidFilePath()
  try {
    fs.unlinkSync(pidFile)
    console.log('[Desktop] PID file removed')
  } catch {
    // File may already be gone
  }
}

function killStaleProcessGroup(pid: number): void {
  const isWindows = process.platform === 'win32'

  if (isWindows) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' })
      console.log(`[Desktop] Killed stale process tree pid=${pid}`)
    } catch {
      console.log(`[Desktop] Stale process ${pid} already dead`)
    }
    return
  }

  const pgid = -pid
  try {
    process.kill(pgid, 'SIGTERM')
    console.log(`[Desktop] Sent SIGTERM to stale process group ${pgid}`)
  } catch {
    console.log(`[Desktop] Stale process group ${pgid} already dead`)
    return
  }
  try {
    execSync('sleep 1')
    process.kill(pgid, 'SIGKILL')
    console.log(`[Desktop] Sent SIGKILL to stale process group ${pgid}`)
  } catch {
    console.log(`[Desktop] Stale process group ${pgid} exited after SIGTERM`)
  }
}

function cleanupStaleProcesses(): void {
  const fs = require('fs') as typeof import('fs')
  const pidFile = getPidFilePath()

  if (fs.existsSync(pidFile)) {
    try {
      const stalePid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      if (stalePid && !isNaN(stalePid)) {
        console.log(`[Desktop] Stale PID file found: pid=${stalePid}, killing process group...`)
        killStaleProcessGroup(stalePid)
      }
    } catch (err) {
      console.warn('[Desktop] Error reading stale PID file:', err)
    }
    removePidFile()
  }

  // Kill orphaned QEMU processes from a previous session
  try {
    execSync('pkill -f qemu-system 2>/dev/null || true', { stdio: 'pipe' })
    console.log('[Desktop] Killed stale QEMU processes (if any)')
  } catch {}

  // Safety net: kill whatever is on our preferred port
  killProcessOnPort(PREFERRED_PORT)
}

function killProcessOnPort(port: number): void {
  const isWindows = process.platform === 'win32'

  try {
    if (isWindows) {
      const result = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim()
      if (!result) return

      const pids = [...new Set(
        result.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(Boolean)
      )] as string[]
      const selfPid = String(process.pid)
      const safePids = pids.filter(p => p !== selfPid && p !== '0')

      if (safePids.length === 0) return

      console.log(`[Desktop] Port ${port} in use by pid(s)=${safePids.join(',')}, killing...`)
      for (const pid of safePids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' })
        } catch { /* already dead */ }
      }
      console.log(`[Desktop] Killed stale process(es) on port ${port}`)
    } else {
      const result = execSync(
        `lsof -ti tcp:${port} 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim()
      if (!result) return

      const pids = result.split('\n').filter(Boolean)
      const selfPid = String(process.pid)
      const safePids = pids.filter(p => p !== selfPid)

      if (safePids.length === 0) {
        console.log(`[Desktop] Port ${port} held by current process, skipping`)
        return
      }

      console.log(`[Desktop] Port ${port} in use by pid(s)=${safePids.join(',')}, killing...`)
      for (const pid of safePids) {
        try {
          execSync(`kill -9 ${pid} 2>/dev/null || true`)
        } catch { /* already dead */ }
      }
      execSync('sleep 1')
      console.log(`[Desktop] Killed stale process(es) on port ${port}`)
    }
  } catch {
    // Port is free or command not available
  }
}

// --- Runtime template provisioning ---

function ensureRuntimeTemplate(): void {
  const fs = require('fs') as typeof import('fs')
  const workspacesDir = getWorkspacesDir()
  const templateDest = path.join(workspacesDir, '_template')
  const bundledTemplate = path.join(getProjectRoot(), 'runtime-template')

  const templatePresent = fs.existsSync(path.join(templateDest, 'package.json'))

  if (!templatePresent) {
    if (!fs.existsSync(bundledTemplate)) {
      console.warn('[Desktop] Bundled runtime-template not found at', bundledTemplate)
      return
    }
    console.log(`[Desktop] Copying runtime-template to ${templateDest}`)
    fs.cpSync(bundledTemplate, templateDest, {
      recursive: true,
      filter: (src: string) => !src.includes('node_modules') && !src.includes('.git'),
    })
    console.log('[Desktop] Runtime template installed')
  } else {
    console.log('[Desktop] Runtime template already present at', templateDest)
  }

  // Self-heal existing installs: ensure AGENTS.md exists at template root. Its
  // absence triggers the agent-runtime's legacy-APP-layout migration on every
  // fresh project, which fails with EPERM on Windows when Vite is watching the
  // workspace. Having AGENTS.md at root skips the migration entirely.
  const agentsMdDest = path.join(templateDest, 'AGENTS.md')
  const agentsMdSrc = path.join(bundledTemplate, 'AGENTS.md')
  if (!fs.existsSync(agentsMdDest) && fs.existsSync(agentsMdSrc)) {
    fs.copyFileSync(agentsMdSrc, agentsMdDest)
    console.log('[Desktop] Added missing AGENTS.md to runtime template')
  }
}

// --- VM isolation ---

function getVMImageDir(): string {
  const { app } = require('electron')
  if (!app.isPackaged) return path.join(path.resolve(__dirname, '..'), 'resources', 'vm')
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return path.join(app.getPath('userData'), 'vm-images', arch)
}

function getVMBundleDir(projectRoot: string, isDev: boolean): string {
  if (isDev) return ''
  return path.join(projectRoot, 'vm-bundle')
}

function isVMIsolationEnabled(): boolean {
  try {
    const { readConfig } = require('./config') as typeof import('./config')
    const config = readConfig()
    const setting = config.vmIsolation?.enabled ?? 'auto'
    if (setting === false) return false
    if (setting === true) return true
    return isVMAvailable()
  } catch {
    return isVMAvailable()
  }
}

// --- Main server lifecycle ---

export async function startLocalServer(): Promise<void> {
  const bunPath = getBunPath()
  const projectRoot = getProjectRoot()
  const isWindows = process.platform === 'win32'
  const IS_DEV = !require('electron').app.isPackaged

  const bundleDir = path.join(projectRoot, 'bundle')
  const serverEntry = IS_DEV
    ? path.join(projectRoot, 'apps', 'api', 'src', 'entry.ts')
    : path.join(bundleDir, 'api.js')

  // Kill leftover processes from a previous session
  cleanupStaleProcesses()

  // Ensure runtime-template is available in the workspaces dir for RuntimeManager's fallback
  ensureRuntimeTemplate()

  // Detect VM isolation availability (the API server manages the VM pool itself)
  const vmIsolationAvailable = isVMIsolationEnabled()
  if (vmIsolationAvailable) {
    console.log('[Desktop] VM isolation available — API will manage VM warm pool')
  } else {
    console.log('[Desktop] VM isolation not available, using host execution')
  }

  apiPort = await findFreePort()
  if (apiPort !== PREFERRED_PORT) {
    console.log(`[Desktop] Port ${PREFERRED_PORT} is in use, using port ${apiPort} instead`)
  }

  const os = require('os') as typeof import('os')
  const bunDir = path.dirname(bunPath)
  const pathSep = isWindows ? ';' : ':'
  const defaultPath = isWindows ? '' : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  const { app } = require('electron') as typeof import('electron')
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${bunDir}${pathSep}${process.env.PATH || defaultPath}`,
    HOME: process.env.HOME || process.env.USERPROFILE || os.homedir(),
    SHOGO_LOCAL_MODE: 'true',
    APP_VERSION: app.getVersion(),
    DATABASE_URL: `file:${getDbPath()}`,
    WORKSPACES_DIR: getWorkspacesDir(),
    S3_ENABLED: 'false',
    API_PORT: String(apiPort),
    PORT: String(apiPort),
    RUNTIME_BASE_PORT: String(RUNTIME_BASE_PORT),
    NODE_ENV: 'development',
    BETTER_AUTH_SECRET: getOrCreateAuthSecret(),
    BETTER_AUTH_URL: `http://localhost:${apiPort}`,
    BUN_INSTALL_CACHE_DIR: path.join(getWorkspacesDir(), '..', '.bun-cache'),
    SHOGO_BUN_PATH: bunPath,
    AGENT_RUNTIME_ENTRY: IS_DEV
      ? path.join(projectRoot, 'packages', 'agent-runtime', 'src', 'entry.ts')
      : path.join(bundleDir, 'agent-runtime.js'),
    CANVAS_RUNTIME_DIST: IS_DEV
      ? path.join(projectRoot, 'packages', 'canvas-runtime', 'dist')
      : path.join(projectRoot, 'canvas-runtime'),
    CANVAS_GLOBALS_DTS: IS_DEV
      ? path.join(projectRoot, 'packages', 'canvas-runtime', 'src', 'canvas-globals.d.ts')
      : path.join(projectRoot, 'canvas-runtime', 'canvas-globals.d.ts'),
    ...(IS_DEV ? {} : {
      TREE_SITTER_WASM_DIR: path.join(projectRoot, 'tree-sitter-wasm'),
      // Point Playwright at the Chromium copy bundled into resources/
      // by apps/desktop/scripts/bundle-api.mjs. Without this, playwright-core
      // would look in ~/AppData/Local/ms-playwright (or ~/.cache on linux/mac),
      // which is empty for end users who never ran `playwright install`.
      PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, 'ms-playwright'),
    }),
    SHOGO_DATA_DIR: getDataDir(),
    SHOGO_SHERPA_DIR: path.join(getDataDir(), 'sherpa-onnx'),
    SHOGO_VM_IMAGE_DIR: getVMImageDir(),
    ...(vmIsolationAvailable ? {
      SHOGO_VM_ISOLATION: 'true',
      SHOGO_VM_BUNDLE_DIR: getVMBundleDir(projectRoot, IS_DEV),
    } : {}),
  }

  ensureDatabase(bunPath)
  runMigrations(bunPath, env)

  // Preflight: on Windows, the RuntimeManager shells out to `npm.cmd` for
  // project dependency installs (Bun 1.x has a hardlink bug on Windows that
  // produces empty node_modules stubs). Without Node.js installed, project
  // runs fail with a cryptic "'npm.cmd' is not recognized" deep inside the
  // API logs, surfaced to users only as "trouble starting your project
  // environment". Detect here and log a single, obvious warning so the
  // prerequisite is visible immediately on startup.
  if (process.platform === 'win32' && !isNpmAvailable(env.PATH)) {
    console.warn(
      '[Desktop] WARNING: Node.js is not installed. Shogo Desktop on Windows ' +
        'requires Node.js 20+ (LTS) for project sandboxes. Running projects ' +
        'will fail until Node.js is installed from https://nodejs.org/.',
    )
  }

  console.log(`[Desktop] Starting local API server: ${bunPath} ${serverEntry}`)
  console.log(`[Desktop] Database: ${getDbPath()}`)
  console.log(`[Desktop] Workspaces: ${getWorkspacesDir()}`)
  console.log(`[Desktop] Ports: API=${apiPort}, RuntimeBase=${RUNTIME_BASE_PORT}`)

  apiProcess = spawn(bunPath, [serverEntry], {
    cwd: getProjectRoot(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
    windowsHide: true,
  })

  console.log(`[Desktop] API process spawned: pid=${apiProcess.pid}`)

  if (apiProcess.pid) {
    writePidFile(apiProcess.pid)
  }

  apiProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[API] ${data.toString().trim()}`)
  })

  apiProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[API] ${data.toString().trim()}`)
  })

  apiProcess.on('error', (err) => {
    console.error('[Desktop] Failed to start API server:', err)
  })

  apiProcess.on('exit', (code, signal) => {
    console.log(`[Desktop] API server exited: code=${code}, signal=${signal}`)
    apiProcess = null
    removePidFile()
  })

  // Unref so the detached process group doesn't keep Electron alive if cleanup fails
  apiProcess.unref()

  await waitForHealth()
}

export async function stopLocalServer(): Promise<void> {
  if (!apiProcess) {
    console.log('[Desktop] No API process to stop')
    return
  }

  const pid = apiProcess.pid
  console.log(`[Desktop] Stopping local API server (pid=${pid})...`)

  if (!pid) {
    console.warn('[Desktop] API process has no pid, cannot kill')
    apiProcess = null
    removePidFile()
    return
  }

  const isWindows = process.platform === 'win32'

  if (isWindows) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' })
      console.log(`[Desktop] Killed API process tree pid=${pid}`)
    } catch (err) {
      console.log(`[Desktop] taskkill failed (already dead?): ${err}`)
    }
    apiProcess = null
    removePidFile()
    return
  }

  const pgid = -pid

  try {
    process.kill(pgid, 'SIGTERM')
    console.log(`[Desktop] Sent SIGTERM to process group ${pgid}`)
  } catch (err) {
    console.log(`[Desktop] SIGTERM to group ${pgid} failed (already dead?): ${err}`)
    apiProcess = null
    removePidFile()
    return
  }

  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[Desktop] Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) reached, sending SIGKILL`)
      try {
        process.kill(pgid, 'SIGKILL')
        console.log(`[Desktop] Sent SIGKILL to process group ${pgid}`)
      } catch (err) {
        console.log(`[Desktop] SIGKILL to group ${pgid} failed: ${err}`)
      }
      resolve(false)
    }, SHUTDOWN_TIMEOUT_MS)

    apiProcess?.on('exit', () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

  console.log(`[Desktop] API server process group terminated (graceful=${exited})`)
  apiProcess = null
  removePidFile()
}

function ensureDatabase(bunPath: string): void {
  const fs = require('fs') as typeof import('fs')
  const dbPath = getDbPath()

  if (fs.existsSync(dbPath)) {
    console.log('[Desktop] Database already exists')
    return
  }

  const seedPath = path.join(getProjectRoot(), 'seed.db')
  if (fs.existsSync(seedPath)) {
    console.log('[Desktop] Initializing database from seed...')
    fs.copyFileSync(seedPath, dbPath)
    baselineMigrations(bunPath, dbPath)
    console.log('[Desktop] Database initialized from seed')
    return
  }

  // Dev mode: create empty database file — Prisma migrations will set up the schema
  const IS_DEV = !require('electron').app.isPackaged
  if (IS_DEV) {
    console.log('[Desktop] Dev mode: creating empty database (migrations will initialize schema)')
    const dbDir = path.dirname(dbPath)
    fs.mkdirSync(dbDir, { recursive: true })
    fs.writeFileSync(dbPath, '')
    return
  }

  throw new Error(`Seed database not found at ${seedPath}`)
}

/**
 * Cheap check for Node.js on Windows — looks for `npm.cmd` in the standard
 * install dir and on PATH. Kept self-contained here (rather than importing
 * from @shogo/shared-runtime) so the desktop bundle doesn't pull in the
 * whole shared-runtime graph just for a startup preflight.
 */
function isNpmAvailable(pathEnv: string | undefined): boolean {
  if (process.platform !== 'win32') return true
  if (existsSync(path.join('C:\\Program Files\\nodejs', 'npm.cmd'))) return true
  if (!pathEnv) return false
  for (const dir of pathEnv.split(';')) {
    if (dir && existsSync(path.join(dir, 'npm.cmd'))) return true
  }
  return false
}

function listBundledMigrationNames(): string[] {
  const fs = require('fs') as typeof import('fs')
  const migrationsDir = path.join(getProjectRoot(), 'prisma', 'migrations')
  if (!fs.existsSync(migrationsDir)) return []

  return fs.readdirSync(migrationsDir).filter((d: string) => {
    const full = path.join(migrationsDir, d)
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'migration.sql'))
  }).sort()
}

/**
 * Records every bundled Prisma migration as already-applied in the target
 * SQLite database. Used after copying seed.db (whose schema is already at
 * the latest migration) so that `prisma migrate deploy` reports
 * "No pending migrations" instead of failing with P3005.
 *
 * Historically this shelled out to the `sqlite3` CLI, which is not present
 * on a stock Windows install — the previous implementation silently warned
 * and skipped, leaving the database in a half-baselined state that crashed
 * on the next launch with P3005. The bundled `bun` binary is already a hard
 * dependency (it runs the API server) and ships with `bun:sqlite`, so we
 * reuse it here for a portable, dependency-free baseline.
 */
function baselineMigrations(bunPath: string, dbPath: string): void {
  const dirs = listBundledMigrationNames()
  if (dirs.length === 0) return

  // Under `bun -e`, process.argv is [bunExecutable, ...positionalArgs] with
  // no script-path placeholder (unlike Node). So argv[1] is the first arg we
  // pass, not argv[2]. A leading "--" is stripped by bun, hence omitted below.
  const script = `
    const { Database } = require("bun:sqlite");
    const { randomUUID } = require("node:crypto");
    const db = new Database(process.argv[1]);
    const names = process.argv.slice(2);
    db.exec(\`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      );
    \`);
    // Idempotent: skip names that already have a row. We can't rely on
    // PRIMARY KEY conflict because the PK is a random UUID per row.
    const existing = new Set(
      db.query('SELECT migration_name FROM "_prisma_migrations"').all()
        .map((r) => r.migration_name)
    );
    const stmt = db.prepare(
      'INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count","started_at") VALUES (?, ?, ?, ?, 1, ?)'
    );
    const now = new Date().toISOString();
    let inserted = 0;
    for (const name of names) {
      if (existing.has(name)) continue;
      stmt.run(randomUUID(), "baseline-seed", now, name, now);
      inserted++;
    }
    db.close();
    console.log(JSON.stringify({ inserted, total: names.length, skipped: names.length - inserted }));
  `

  try {
    const out = execFileSync(bunPath, ['-e', script, dbPath, ...dirs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      encoding: 'utf-8',
    }).trim()
    console.log(`[Desktop] Baselined ${dirs.length} migration(s) for seed database: ${out}`)
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || ''
    const stdout = err?.stdout?.toString?.() || ''
    console.error('[Desktop] Failed to baseline seed database:', stderr || stdout || err)
    // Do not swallow this error — leaving the DB half-baselined causes
    // `prisma migrate deploy` to fail with P3005 on the next launch (issue
    // seen on Windows where the old implementation's sqlite3 CLI fallback
    // silently no-oped).
    throw new Error(`Failed to baseline seed database: ${stderr || stdout || err?.message || err}`)
  }
}

function getSchemaEngineName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32') return `schema-engine-windows.exe`
  if (platform === 'darwin' && arch === 'arm64') return `schema-engine-darwin-arm64`
  if (platform === 'darwin') return `schema-engine-darwin`
  return `schema-engine-debian-openssl-3.0.x`
}

function runMigrations(bunPath: string, env: Record<string, string>): void {
  const fs = require('fs') as typeof import('fs')
  const projectRoot = getProjectRoot()
  const IS_DEV = !require('electron').app.isPackaged

  if (IS_DEV) {
    console.log('[Desktop] Dev mode: running SQLite migrations...')
    try {
      const result = execSync(
        `"${bunPath}" x prisma migrate deploy --config=prisma.config.local.ts`,
        {
          cwd: projectRoot,
          env,
          stdio: 'pipe',
          timeout: 30000,
          encoding: 'utf-8',
        }
      )
      console.log('[Desktop] Migrations complete:', result.trim())
    } catch (err: any) {
      const stderr = err.stderr?.toString() || ''
      const stdout = err.stdout?.toString() || ''
      if (stdout.includes('No pending migrations') || stderr.includes('No pending migrations')) {
        console.log('[Desktop] Database schema is up to date')
        return
      }
      console.error('[Desktop] Migration failed:', stderr || err.message)
      console.error('[Desktop] Migration stdout:', stdout)
      throw new Error('Failed to run database migrations')
    }
    return
  }

  // Copy schema-engine binary to a writable location (Prisma needs it for SQLite)
  const { getDataDir } = require('./paths') as typeof import('./paths')
  const writableEngineDir = path.join(getDataDir(), '.prisma-engines')
  fs.mkdirSync(writableEngineDir, { recursive: true })

  const bundledEnginesDir = path.join(projectRoot, 'node_modules', '@prisma', 'engines')
  if (fs.existsSync(bundledEnginesDir)) {
    for (const f of fs.readdirSync(bundledEnginesDir)) {
      if (f.startsWith('schema-engine')) {
        const src = path.join(bundledEnginesDir, f)
        const dst = path.join(writableEngineDir, f)
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst)
          try { fs.chmodSync(dst, 0o755) } catch { /* Windows doesn't need chmod */ }
        }
      }
    }
  }

  const runDeploy = (): { stdout: string; stderr: string; ok: boolean; error?: any } => {
    try {
      const result = execSync(
        `"${bunPath}" x prisma migrate deploy --config=prisma.config.js`,
        {
          cwd: projectRoot,
          env: {
            ...env,
            PRISMA_SCHEMA_ENGINE_BINARY: path.join(writableEngineDir, getSchemaEngineName()),
          },
          stdio: 'pipe',
          timeout: 30000,
          encoding: 'utf-8',
        }
      )
      return { stdout: result, stderr: '', ok: true }
    } catch (err: any) {
      return {
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
        ok: false,
        error: err,
      }
    }
  }

  console.log('[Desktop] Running database migrations...')
  let attempt = runDeploy()

  // Self-heal for users whose install pre-dates the baseline fix: the seed DB
  // was copied but `_prisma_migrations` never populated (the old sqlite3 CLI
  // path silently no-oped on systems without sqlite3). Prisma then reports
  // P3005 "database schema is not empty". Baseline the existing DB and retry
  // once so the app can boot instead of being permanently broken.
  if (!attempt.ok && (attempt.stdout + attempt.stderr).includes('P3005')) {
    console.warn('[Desktop] Detected P3005 — baselining existing database and retrying migrations')
    try {
      baselineMigrations(bunPath, getDbPath())
    } catch (err) {
      console.error('[Desktop] P3005 self-heal failed during baseline:', err)
      throw new Error('Failed to run database migrations (P3005 self-heal could not baseline)')
    }
    attempt = runDeploy()
  }

  if (attempt.ok) {
    console.log('[Desktop] Migrations complete:', attempt.stdout.trim())
    return
  }

  if (
    attempt.stdout.includes('No pending migrations') ||
    attempt.stderr.includes('No pending migrations')
  ) {
    console.log('[Desktop] Database schema is up to date')
    return
  }

  console.error('[Desktop] [ERROR] Migration failed:', attempt.stderr || attempt.error?.message)
  console.error('[Desktop] [ERROR] Migration stdout:', attempt.stdout)
  throw new Error('Failed to run database migrations')
}

async function waitForHealth(): Promise<void> {
  const url = `${getApiUrl()}/health`

  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        console.log('[Desktop] API server is healthy')
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY_MS))
  }

  throw new Error(`API server failed to start after ${MAX_HEALTH_RETRIES} retries`)
}

function getOrCreateAuthSecret(): string {
  const fs = require('fs') as typeof import('fs')
  const { getDataDir } = require('./paths') as typeof import('./paths')
  const secretPath = path.join(getDataDir(), '.auth-secret')

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf-8').trim()
  }

  const crypto = require('crypto') as typeof import('crypto')
  const secret = crypto.randomBytes(32).toString('base64')
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}
