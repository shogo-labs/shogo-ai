// SPDX-License-Identifier: MIT
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
  // Use `app.getAppPath()` (= `apps/desktop/` in dev) instead of
  // `path.resolve(__dirname, '..')`. `bun build` inlines `__dirname` as a
  // build-time absolute path into the desktop bundle, so any runtime use of
  // `__dirname` from a bundled module points at the build machine's
  // filesystem layout, not the user's. See `scripts/bundle-main.mjs`.
  if (!app.isPackaged) return path.join(app.getAppPath(), 'resources', 'vm')
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
    // Path-safe SDK CLI fallback. PreviewManager uses this when a
    // project's `package.json` declares the legacy
    // `"generate": "bunx shogo generate"` script — `bunx` would resolve
    // that to the published @shogo-ai/sdk@0.4.0, whose execSync-based
    // sub-shell breaks on workspace paths containing spaces (notably
    // every macOS install under "~/Library/Application Support/Shogo").
    // 0.4.1 fixed the bug but was never published to npm, so we ship
    // the in-repo CLI as a sibling resource and route around the
    // broken script when detected. See apps/desktop/scripts/bundle-api.mjs
    // for the bundling step.
    SHOGO_BUNDLED_SDK_CLI: IS_DEV
      ? path.join(projectRoot, 'packages', 'sdk', 'bin', 'cli.mjs')
      : path.join(projectRoot, 'sdk-cli.mjs'),
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
      // Point MCPClient at the bundled MCP packages copied into resources/
      // by apps/desktop/scripts/bundle-api.mjs. Without this, the runtime's
      // default `/app/mcp-packages` path doesn't exist on desktop and the
      // first agent invocation of e.g. `computer-use-mcp` would pay the
      // ~30-45s cold `npx` install cost. With this set, mcp-client.ts
      // resolves to a direct `node <pkg>/dist/main.js` instead.
      MCP_PREINSTALL_DIR: path.join(projectRoot, 'mcp-packages'),
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
 * Records bundled Prisma migrations as applied in the target SQLite database.
 *
 * Three modes:
 *
 *   - `'seed'`:    Mark **every** bundled migration as applied without running
 *                  any SQL. Correct only when called right after copying a
 *                  fresh `seed.db` (whose schema is already at HEAD).
 *
 *   - `'introspect'`: P3005 self-heal for existing user databases. Reads each
 *                     migration's SQL, introspects the live schema, and for
 *                     additive statements (`ALTER TABLE … ADD COLUMN`,
 *                     `CREATE TABLE`) replays the ones whose target is still
 *                     missing. Migrations with statements we can't safely
 *                     classify are left un-baselined so `prisma migrate deploy`
 *                     can attempt them. This avoids the historical footgun
 *                     where the old `'seed'`-style self-heal silently marked
 *                     all migrations as applied against a stale schema and
 *                     left columns like `subscriptions.seats` missing forever.
 *
 *   - `'rescue'`:  Drift repair sweep. Runs on **every** launch and never
 *                  touches `_prisma_migrations`. For every bundled migration
 *                  (including ones already marked applied), scans for
 *                  `ALTER TABLE … ADD COLUMN` / `CREATE TABLE` /
 *                  `CREATE INDEX` / `DROP INDEX` and re-runs only those
 *                  whose target is currently missing. This is the *only*
 *                  thing that recovers a user whose `seed.db` was generated
 *                  at build time without the seats column: their
 *                  `_prisma_migrations` table marks the seats migration as
 *                  applied (so `prisma migrate deploy` does nothing), and
 *                  `'introspect'` mode also skips it because it's in
 *                  `existing`. Only this rescue pass actually re-applies the
 *                  ALTER TABLE.
 *
 * Historically this shelled out to the `sqlite3` CLI, which is not present
 * on a stock Windows install — the previous implementation silently warned
 * and skipped, leaving the database in a half-baselined state that crashed
 * on the next launch with P3005. The bundled `bun` binary is already a hard
 * dependency (it runs the API server) and ships with `bun:sqlite`, so we
 * reuse it here for a portable, dependency-free baseline.
 */
function baselineMigrations(
  bunPath: string,
  dbPath: string,
  mode: 'seed' | 'introspect' | 'rescue' = 'seed',
): void {
  const dirs = listBundledMigrationNames()
  if (dirs.length === 0) return

  const migrationsDir = path.join(getProjectRoot(), 'prisma', 'migrations')

  // Under `bun -e`, process.argv is [bunExecutable, ...positionalArgs] with
  // no script-path placeholder (unlike Node). So argv[1] is the first arg we
  // pass, not argv[2]. A leading "--" is stripped by bun, hence omitted below.
  // argv layout: [dbPath, migrationsDir, mode, ...migrationNames]
  //
  // Wrapped in an IIFE so the 'seed' early-return is legal — top-level
  // `return` is a SyntaxError under `bun -e` (script body is parsed as a
  // module, not a function), and bun won't print *anything* if it can't
  // parse the script, which makes the failure silent.
  const script = `
  (function main() {
    const fs = require("node:fs");
    const path = require("node:path");
    const { Database } = require("bun:sqlite");
    const { randomUUID } = require("node:crypto");
    const db = new Database(process.argv[1]);
    const migrationsDir = process.argv[2];
    const mode = process.argv[3];
    const names = process.argv.slice(4);
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

    const existing = new Set(
      db.query('SELECT migration_name FROM "_prisma_migrations"').all()
        .map((r) => r.migration_name)
    );

    const insertStmt = db.prepare(
      'INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count","started_at") VALUES (?, ?, ?, ?, 1, ?)'
    );

    function nowIso() { return new Date().toISOString(); }
    function baseline(name, checksum) {
      if (existing.has(name)) return false;
      insertStmt.run(randomUUID(), checksum, nowIso(), name, nowIso());
      existing.add(name);
      return true;
    }

    // Introspect live schema into { tableName: Set<columnName> }
    function loadSchema() {
      const tables = new Map();
      for (const row of db.query("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const cols = new Set(
          db.query(\`PRAGMA table_info("\${row.name.replace(/"/g, '""')}")\`).all().map((r) => r.name)
        );
        tables.set(row.name, cols);
      }
      return tables;
    }

    function splitSqlStatements(sql) {
      // Strip block & line comments, then split on ';' at end of line. Good
      // enough for Prisma-generated SQLite migrations (no PL/pgSQL etc.).
      const noBlock = sql.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
      const noLine = noBlock.replace(/--[^\\n]*\\n/g, '\\n');
      return noLine
        .split(/;\\s*(?:\\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    // mode === 'seed': legacy behavior — mark all as applied, no SQL replay.
    if (mode === 'seed') {
      let inserted = 0;
      for (const name of names) {
        if (baseline(name, 'baseline-seed')) inserted++;
      }
      db.close();
      console.log(JSON.stringify({ mode, inserted, total: names.length, skipped: names.length - inserted }));
      return;
    }

    // mode === 'rescue': drift repair. Re-run any ADD COLUMN / CREATE TABLE /
    // DROP INDEX whose target is missing in the live schema, regardless of
    // whether the migration is recorded in _prisma_migrations. NEVER touches
    // _prisma_migrations. Designed to be safe to run on every launch.
    if (mode === 'rescue') {
      const repaired = [];
      const tables = loadSchema();
      for (const name of names) {
        const sqlPath = path.join(migrationsDir, name, 'migration.sql');
        let sql;
        try { sql = fs.readFileSync(sqlPath, 'utf-8'); } catch { continue; }
        for (const stmt of splitSqlStatements(sql)) {
          const addCol = stmt.match(/^ALTER\\s+TABLE\\s+"?(\\w+)"?\\s+ADD\\s+COLUMN\\s+"?(\\w+)"?/i);
          if (addCol) {
            const [, table, col] = addCol;
            const cols = tables.get(table);
            if (!cols) continue;            // table absent → skip (rescue can't create FKs etc.)
            if (cols.has(col)) continue;    // already applied
            try {
              db.exec(stmt);
              cols.add(col);
              repaired.push({ kind: 'add_col', migration: name, table, col });
            } catch (e) {
              const msg = String(e && e.message || e);
              if (!/duplicate column/i.test(msg)) {
                repaired.push({ kind: 'add_col_failed', migration: name, table, col, error: msg });
              }
            }
            continue;
          }
          const createTbl = stmt.match(/^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?(\\w+)"?/i);
          if (createTbl) {
            const [, table] = createTbl;
            if (tables.has(table)) continue;
            try {
              db.exec(stmt);
              tables.set(table, new Set());
              repaired.push({ kind: 'create_table', migration: name, table });
            } catch (e) {
              const msg = String(e && e.message || e);
              if (!/already exists/i.test(msg)) {
                repaired.push({ kind: 'create_table_failed', migration: name, table, error: msg });
              }
            }
            continue;
          }
          // Other statements (UPDATE, RENAME, etc.) are NOT replayed by rescue.
        }
      }
      db.close();
      console.log(JSON.stringify({ mode, repaired, repairedCount: repaired.length, total: names.length }));
      return;
    }

    // mode === 'introspect': replay-or-baseline based on actual schema state.
    let baselined = 0, replayed = 0, deferred = 0, skipped = 0;
    const deferredNames = [];
    const replayedNames = [];

    for (const name of names) {
      if (existing.has(name)) { skipped++; continue; }
      const sqlPath = path.join(migrationsDir, name, 'migration.sql');
      let sql;
      try { sql = fs.readFileSync(sqlPath, 'utf-8'); }
      catch { baseline(name, 'baseline-introspect-no-sql'); baselined++; continue; }

      const tables = loadSchema();
      const stmts = splitSqlStatements(sql);
      let canRescue = true;
      const toExecute = [];

      for (const stmt of stmts) {
        const addCol = stmt.match(/^ALTER\\s+TABLE\\s+"?(\\w+)"?\\s+ADD\\s+COLUMN\\s+"?(\\w+)"?/i);
        if (addCol) {
          const [, table, col] = addCol;
          const cols = tables.get(table);
          if (cols && cols.has(col)) continue;
          toExecute.push({ kind: 'add_col', table, col, stmt });
          continue;
        }
        const createTbl = stmt.match(/^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?(\\w+)"?/i);
        if (createTbl) {
          const [, table] = createTbl;
          if (tables.has(table)) continue;
          toExecute.push({ kind: 'create_table', table, stmt });
          continue;
        }
        const createIdx = stmt.match(/^CREATE\\s+(UNIQUE\\s+)?INDEX/i);
        if (createIdx) {
          // SQLite supports IF NOT EXISTS on CREATE INDEX; safe to attempt.
          toExecute.push({ kind: 'create_index', stmt });
          continue;
        }
        // PRAGMA is connection-scoped, idempotent, and routinely used at
        // the top of Prisma SQLite migrations to toggle foreign_keys.
        if (/^PRAGMA\\s/i.test(stmt)) {
          toExecute.push({ kind: 'pragma', stmt });
          continue;
        }
        // DROP INDEX is safe — if the index doesn't exist with IF EXISTS
        // it's a no-op; without IF EXISTS we treat a "no such index" error
        // as success below. Old indexes that we never created on this DB
        // are exactly the kind of thing migrations clean up.
        if (/^DROP\\s+INDEX\\b/i.test(stmt)) {
          toExecute.push({ kind: 'drop_index', stmt });
          continue;
        }
        // Anything else (RENAME, UPDATE, INSERT, foreign-key emulation
        // via temp tables, etc.) we won't reason about. Defer to prisma.
        canRescue = false;
        break;
      }

      if (!canRescue) {
        deferred++;
        deferredNames.push(name);
        continue;
      }

      for (const action of toExecute) {
        try {
          db.exec(action.stmt);
          if (action.kind === 'add_col') {
            const cols = tables.get(action.table);
            if (cols) cols.add(action.col);
          } else if (action.kind === 'create_table') {
            tables.set(action.table, new Set());
          }
        } catch (e) {
          // Best-effort: ignore idempotency-style errors, bail on real ones.
          const msg = String(e && e.message || e);
          if (/duplicate column|already exists|no such index/i.test(msg)) continue;
          canRescue = false;
          break;
        }
      }

      if (!canRescue) {
        deferred++;
        deferredNames.push(name);
        continue;
      }

      baseline(name, toExecute.length > 0 ? 'baseline-introspect-replay' : 'baseline-introspect');
      if (toExecute.length > 0) {
        replayed++;
        replayedNames.push(name);
      } else {
        baselined++;
      }
    }

    db.close();
    console.log(JSON.stringify({
      mode,
      baselined,
      replayed,
      deferred,
      skipped,
      total: names.length,
      replayedNames,
      deferredNames,
    }));
  })();
  `

  const args = ['-e', script, dbPath, migrationsDir, mode, ...dirs]
  try {
    const out = execFileSync(bunPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      encoding: 'utf-8',
    }).trim()
    console.log(`[Desktop] baselineMigrations(${mode}) result: ${out}`)
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
      } else {
        console.error('[Desktop] Migration failed:', stderr || err.message)
        console.error('[Desktop] Migration stdout:', stdout)
        throw new Error('Failed to run database migrations')
      }
    }
    try {
      baselineMigrations(bunPath, getDbPath(), 'rescue')
    } catch (rescueErr) {
      console.error('[Desktop] Dev-mode schema rescue failed (non-fatal):', rescueErr)
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
  // P3005 "database schema is not empty".
  //
  // We use `'introspect'` mode here, NOT `'seed'`: the live DB may be at an
  // older schema than HEAD (e.g. missing `subscriptions.seats`), and seed-
  // style baselining would silently mark the un-applied migration as done,
  // permanently breaking subsequent reads of those columns. Introspect mode
  // reads each migration's SQL, replays additive `ADD COLUMN`/`CREATE TABLE`
  // statements whose target isn't in the live schema, and defers anything
  // else to the subsequent `prisma migrate deploy` retry.
  if (!attempt.ok && (attempt.stdout + attempt.stderr).includes('P3005')) {
    console.warn('[Desktop] Detected P3005 — introspecting existing database and replaying missing migrations')
    try {
      baselineMigrations(bunPath, getDbPath(), 'introspect')
    } catch (err) {
      console.error('[Desktop] P3005 self-heal failed during introspect:', err)
      throw new Error('Failed to run database migrations (P3005 self-heal could not baseline)')
    }
    attempt = runDeploy()
  }

  // Rescue pass: even when `prisma migrate deploy` says everything is fine,
  // the schema may be drifted — specifically, an early v1.5.x `seed.db` was
  // generated by `prisma db push` before `schema.local.prisma` had the
  // `seats` column, but the bundled `_prisma_migrations` baseline marked
  // the seats migration as applied anyway. Result: `_prisma_migrations`
  // says 19/19 applied, `prisma migrate deploy` reports "No pending
  // migrations", but `subscriptions.seats` does not exist in the DB.
  // Users in this state are unrecoverable without explicit rescue.
  //
  // This rescue pass runs on every launch, scans every bundled migration
  // for `ADD COLUMN` / `CREATE TABLE` statements whose target is missing
  // in the live schema, and re-applies those statements. It never touches
  // `_prisma_migrations`. It's safe to run repeatedly (it no-ops when
  // schema is healthy) so we don't gate it on the deploy result.
  const runRescue = () => {
    try {
      baselineMigrations(bunPath, getDbPath(), 'rescue')
    } catch (err) {
      console.error('[Desktop] Schema rescue pass failed (non-fatal):', err)
    }
  }

  if (attempt.ok) {
    console.log('[Desktop] Migrations complete:', attempt.stdout.trim())
    runRescue()
    return
  }

  if (
    attempt.stdout.includes('No pending migrations') ||
    attempt.stderr.includes('No pending migrations')
  ) {
    console.log('[Desktop] Database schema is up to date')
    runRescue()
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
