// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local (non-Docker) worker pool for eval runners.
 *
 * Spawns `bun run src/server.ts` as child processes instead of Docker
 * containers. Same HTTP interface as docker-worker — the eval harness
 * talks to workers over localhost regardless of backend.
 *
 * Usage: pass --local to run-eval.ts to skip the Docker image build/run cycle.
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { encodeSecurityPolicy } from '../permission-engine'
import { type DockerWorker, REPO_ROOT } from './docker-worker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalWorkerConfig {
  containerPrefix: string
  baseHostPort: number
  skillServerBasePort: number
  model: string
  verbose: boolean
  envOverrides?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Process tracking
// ---------------------------------------------------------------------------

const _processes = new Map<number, Subprocess>()

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export async function startLocalWorker(
  id: number,
  config: LocalWorkerConfig,
  opts?: { workspaceDir?: string },
): Promise<DockerWorker> {
  const port = config.baseHostPort + id
  const name = `${config.containerPrefix}-${id}`
  const dir = opts?.workspaceDir || resolve(tmpdir(), `${config.containerPrefix}-${id}`)
  const skillPort = config.skillServerBasePort + id

  console.log(`  Starting local worker ${id} (${name}) on port ${port}...`)

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'project'), { recursive: true })

  if (!existsSync(join(dir, 'config.json'))) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      activeMode: 'none',
      heartbeat: { enabled: false, intervalMs: 300000 },
      channels: [],
      skills: [],
      memory: { enabled: false },
    }, null, 2))
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'development',
    PORT: String(port),
    WORKSPACE_DIR: dir,
    AGENT_DIR: dir,
    PROJECT_DIR: dir,
    PROJECT_ID: name,
    AGENT_MODEL: config.model,
    SKILL_SERVER_PORT: String(skillPort),
    SECURITY_POLICY: encodeSecurityPolicy({ mode: 'full_autonomy' }),
  }

  if (config.envOverrides) {
    Object.assign(env, config.envOverrides)
  }

  const runtimeDir = resolve(REPO_ROOT, 'packages/agent-runtime')
  const proc = spawn(['bun', 'run', 'src/server.ts'], {
    cwd: runtimeDir,
    env,
    stdout: config.verbose ? 'inherit' : 'ignore',
    stderr: config.verbose ? 'inherit' : 'ignore',
  })

  _processes.set(id, proc)

  const maxWait = 60_000
  const start = Date.now()
  let delay = 500

  while (Date.now() - start < maxWait) {
    if (proc.exitCode !== null) {
      _processes.delete(id)
      throw new Error(`Worker ${id} process exited with code ${proc.exitCode}. Re-run with --verbose to see output.`)
    }

    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(`http://localhost:${port}/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        const body = await res.json().catch(() => null) as any
        if (body?.gateway?.running === true) {
          console.log(`  Worker ${id} ready on port ${port} (${Date.now() - start}ms)`)
          return { id, port, dir, containerName: name }
        }
        if (config.verbose && Date.now() - start > 5_000) {
          console.log(`  Worker ${id} HTTP ok but gateway not ready yet (${Date.now() - start}ms)`)
        }
      }
    } catch {}

    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2_000)
  }

  stopLocalWorker({ id, port, dir, containerName: name })
  throw new Error(`Local worker ${id} failed to start within ${maxWait}ms`)
}

export function stopLocalWorker(worker: DockerWorker): void {
  const proc = _processes.get(worker.id)
  if (!proc) return
  try { proc.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { proc.kill('SIGKILL') } catch {}
  }, 3_000)
  _processes.delete(worker.id)
}

export function stopAllLocalWorkers(): void {
  for (const [, proc] of _processes) {
    try { proc.kill('SIGTERM') } catch {}
  }
  _processes.clear()
}
