// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import path from 'path'
import { getBunPath, getDbPath, getWorkspacesDir, getProjectRoot } from './paths'

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
  const pgid = -pid
  try {
    process.kill(pgid, 'SIGTERM')
    console.log(`[Desktop] Sent SIGTERM to stale process group ${pgid}`)
  } catch {
    console.log(`[Desktop] Stale process group ${pgid} already dead`)
    return
  }
  // Give it a moment, then force kill
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

  // Safety net: kill whatever is on our preferred port
  killProcessOnPort(PREFERRED_PORT)
}

function killProcessOnPort(port: number): void {
  try {
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
  } catch {
    // Port is free or lsof not available
  }
}

// --- Runtime template provisioning ---

function ensureRuntimeTemplate(): void {
  const fs = require('fs') as typeof import('fs')
  const workspacesDir = getWorkspacesDir()
  const templateDest = path.join(workspacesDir, '_template')

  if (fs.existsSync(path.join(templateDest, 'package.json'))) {
    console.log('[Desktop] Runtime template already present at', templateDest)
    return
  }

  const bundledTemplate = path.join(getProjectRoot(), 'runtime-template')
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
}

// --- Main server lifecycle ---

export async function startLocalServer(): Promise<void> {
  const bunPath = getBunPath()
  const projectRoot = getProjectRoot()
  const bundleDir = path.join(projectRoot, 'bundle')
  const serverEntry = path.join(bundleDir, 'api.js')

  // Kill leftover processes from a previous session
  cleanupStaleProcesses()

  // Ensure runtime-template is available in the workspaces dir for RuntimeManager's fallback
  ensureRuntimeTemplate()

  apiPort = await findFreePort()
  if (apiPort !== PREFERRED_PORT) {
    console.log(`[Desktop] Port ${PREFERRED_PORT} is in use, using port ${apiPort} instead`)
  }

  const os = require('os') as typeof import('os')
  const bunDir = path.dirname(bunPath)
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${bunDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}`,
    HOME: process.env.HOME || os.homedir(),
    SHOGO_LOCAL_MODE: 'true',
    DATABASE_URL: `file:${getDbPath()}`,
    WORKSPACES_DIR: getWorkspacesDir(),
    S3_ENABLED: 'false',
    API_PORT: String(apiPort),
    PORT: String(apiPort),
    RUNTIME_BASE_PORT: String(RUNTIME_BASE_PORT),
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: getOrCreateAuthSecret(),
    BETTER_AUTH_URL: `http://localhost:${apiPort}`,
    BUN_INSTALL_CACHE_DIR: path.join(getWorkspacesDir(), '..', '.bun-cache'),
    PREWARM_CLAUDE_CODE: 'false',
    AGENT_RUNTIME_ENTRY: path.join(bundleDir, 'agent-runtime.js'),
    MCP_SERVER_PATH: path.join(bundleDir, 'mcp-server.js'),
    CANVAS_RUNTIME_DIST: path.join(projectRoot, 'canvas-runtime'),
    CANVAS_GLOBALS_DTS: path.join(projectRoot, 'canvas-runtime', 'canvas-globals.d.ts'),
  }

  ensureDatabase()
  runMigrations(bunPath, env)

  console.log(`[Desktop] Starting local API server: ${bunPath} ${serverEntry}`)
  console.log(`[Desktop] Database: ${getDbPath()}`)
  console.log(`[Desktop] Workspaces: ${getWorkspacesDir()}`)
  console.log(`[Desktop] Ports: API=${apiPort}, RuntimeBase=${RUNTIME_BASE_PORT}`)

  apiProcess = spawn(bunPath, [serverEntry], {
    cwd: getProjectRoot(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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

  const pgid = -pid

  // Send SIGTERM to the entire process group (API + agent-runtime + vite + esbuild)
  try {
    process.kill(pgid, 'SIGTERM')
    console.log(`[Desktop] Sent SIGTERM to process group ${pgid}`)
  } catch (err) {
    console.log(`[Desktop] SIGTERM to group ${pgid} failed (already dead?): ${err}`)
    apiProcess = null
    removePidFile()
    return
  }

  // Wait for graceful exit, then force kill
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

function ensureDatabase(): void {
  const fs = require('fs') as typeof import('fs')
  const dbPath = getDbPath()

  if (fs.existsSync(dbPath)) {
    console.log('[Desktop] Database already exists')
    return
  }

  const seedPath = path.join(getProjectRoot(), 'seed.db')
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed database not found at ${seedPath}`)
  }

  console.log('[Desktop] Initializing database from seed...')
  fs.copyFileSync(seedPath, dbPath)

  baselineMigrations(dbPath)
  console.log('[Desktop] Database initialized')
}

function baselineMigrations(dbPath: string): void {
  const fs = require('fs') as typeof import('fs')
  const migrationsDir = path.join(getProjectRoot(), 'prisma', 'migrations')
  if (!fs.existsSync(migrationsDir)) return

  const dirs = fs.readdirSync(migrationsDir).filter((d: string) => {
    const full = path.join(migrationsDir, d)
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'migration.sql'))
  }).sort()

  if (dirs.length === 0) return

  const crypto = require('crypto') as typeof import('crypto')
  const stmts = [
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );`,
    ...dirs.map((name: string) => {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      return `INSERT OR IGNORE INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count","started_at") VALUES ('${id}','baseline-seed','${now}','${name}',1,'${now}');`
    }),
  ]

  execSync(`/usr/bin/sqlite3 "${dbPath}"`, {
    input: stmts.join('\n'),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  })

  console.log(`[Desktop] Baselined ${dirs.length} migration(s) for seed database`)
}

function runMigrations(bunPath: string, env: Record<string, string>): void {
  const fs = require('fs') as typeof import('fs')
  const projectRoot = getProjectRoot()
  const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js')

  if (!fs.existsSync(prismaCli)) {
    console.log('[Desktop] Prisma CLI not found, skipping migrations')
    return
  }

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
          fs.chmodSync(dst, 0o755)
        }
      }
    }
  }

  console.log('[Desktop] Running database migrations...')
  try {
    const result = execSync(
      `"${bunPath}" "${prismaCli}" migrate deploy`,
      {
        cwd: projectRoot,
        env: {
          ...env,
          PRISMA_SCHEMA_ENGINE_BINARY: path.join(writableEngineDir, 'schema-engine-darwin-arm64'),
        },
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
