// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import { getBunPath, getApiDir, getDbPath, getWorkspacesDir, getProjectRoot } from './paths'

const API_PORT = 8002
const MAX_HEALTH_RETRIES = 60
const HEALTH_RETRY_DELAY_MS = 500

let apiProcess: ChildProcess | null = null

export function getApiUrl(): string {
  return `http://localhost:${API_PORT}`
}

export async function startLocalServer(): Promise<void> {
  const bunPath = getBunPath()
  const projectRoot = getProjectRoot()
  const bundleDir = path.join(projectRoot, 'bundle')
  const serverEntry = path.join(bundleDir, 'api.js')

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    SHOGO_LOCAL_MODE: 'true',
    DATABASE_URL: `file:${getDbPath()}`,
    WORKSPACES_DIR: getWorkspacesDir(),
    S3_ENABLED: 'false',
    API_PORT: String(API_PORT),
    PORT: String(API_PORT),
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: getOrCreateAuthSecret(),
    BETTER_AUTH_URL: `http://localhost:${API_PORT}`,
    BUN_INSTALL_CACHE_DIR: path.join(getWorkspacesDir(), '..', '.bun-cache'),
    PREWARM_CLAUDE_CODE: 'false',
    AGENT_RUNTIME_ENTRY: path.join(bundleDir, 'agent-runtime.js'),
    MCP_SERVER_PATH: path.join(bundleDir, 'mcp-server.js'),
    // Security policy is loaded per-runtime from LocalConfig by RuntimeManager;
    // the desktop server just needs SHOGO_LOCAL_MODE=true to trigger it.
  }

  await initializeDatabase(bunPath, env)

  console.log(`[Desktop] Starting local API server: ${bunPath} ${serverEntry}`)
  console.log(`[Desktop] Database: ${getDbPath()}`)
  console.log(`[Desktop] Workspaces: ${getWorkspacesDir()}`)

  apiProcess = spawn(bunPath, [serverEntry], {
    cwd: getProjectRoot(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

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
  })

  await waitForHealth()
}

export async function stopLocalServer(): Promise<void> {
  if (!apiProcess) return

  console.log('[Desktop] Stopping local API server...')
  apiProcess.kill('SIGTERM')

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (apiProcess && !apiProcess.killed) {
        apiProcess.kill('SIGKILL')
      }
      resolve()
    }, 5000)

    apiProcess?.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })

  apiProcess = null
}

async function initializeDatabase(bunPath: string, env: Record<string, string>): Promise<void> {
  const projectRoot = getProjectRoot()
  console.log('[Desktop] Initializing database schema...')
  try {
    execSync(
      `"${bunPath}" x prisma db push --config=prisma.config.local.ts`,
      { cwd: projectRoot, env, stdio: 'pipe', timeout: 30000 }
    )
    console.log('[Desktop] Database schema is up to date')
  } catch (err: any) {
    console.error('[Desktop] Database init failed:', err.stderr?.toString() || err.message)
    throw new Error('Failed to initialize database')
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
