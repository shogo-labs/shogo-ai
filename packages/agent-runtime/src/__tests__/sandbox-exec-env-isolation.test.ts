// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26: an agent `exec` shell must not inherit the Shogo desktop app's own
 * server identity.
 *
 * The desktop app runs its long-lived API child with `API_PORT=39100`
 * (apps/desktop/src/local-server.ts). Agent runtimes are that child's
 * children, so every agent shell inherited `API_PORT=39100`; `bun dev:all`
 * reads `API_PORT` (scripts/dev-all.ts) and its port-clearing step
 * `kill -9`s whatever listens on it, which SIGKILLed the running app's API.
 *
 * These tests pin the strip list on both exec paths: the native one
 * (`buildExecEnv`) and the docker one (which passes
 * `stripRuntimeVars(getSanitizedEnv())` straight to `docker run`).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildExecEnv,
  getSanitizedEnv,
  sandboxExec,
  stripRuntimeVars,
  RUNTIME_ONLY_VARS,
} from '../sandbox-exec'

/**
 * The desktop app's server-identity vars, with the values it actually sets.
 * `VITE_RUNTIME_BASE` is the renderer-side twin of `RUNTIME_BASE_PORT`.
 */
const DESKTOP_SERVER_VARS: Record<string, string> = {
  API_PORT: '39100',
  PORT: '39201',
  VITE_PORT: '39202',
  RUNTIME_BASE_PORT: '39110',
  VITE_RUNTIME_BASE: 'http://localhost:39110',
  BETTER_AUTH_URL: 'http://localhost:39100',
  API_URL: 'http://localhost:39100',
}

const SAVED_ENV = new Map<string, string | undefined>()

function installDesktopServerEnv(): void {
  for (const [key, value] of Object.entries(DESKTOP_SERVER_VARS)) {
    SAVED_ENV.set(key, process.env[key])
    process.env[key] = value
  }
}

function restoreEnv(): void {
  for (const [key, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  SAVED_ENV.clear()
}

function parseProbeLines(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

// `${VAR-unset}` (no colon) prints "unset" only when the var is ABSENT, so an
// empty-string leak can't hide behind the probe.
const ENV_PROBE = [
  'echo "API_PORT=${API_PORT-unset}"',
  'echo "PORT=${PORT-unset}"',
  'echo "VITE_PORT=${VITE_PORT-unset}"',
  'echo "RUNTIME_BASE_PORT=${RUNTIME_BASE_PORT-unset}"',
  'echo "VITE_RUNTIME_BASE=${VITE_RUNTIME_BASE-unset}"',
  'echo "BETTER_AUTH_URL=${BETTER_AUTH_URL-unset}"',
  'echo "API_URL=${API_URL-unset}"',
  'echo "RUNTIME_PORT=${RUNTIME_PORT-unset}"',
  'echo "DATABASE_URL=${DATABASE_URL-unset}"',
].join(' && ')

describe('RUNTIME_ONLY_VARS', () => {
  test('covers the desktop app server identity, not just PORT/VITE_PORT', () => {
    for (const key of Object.keys(DESKTOP_SERVER_VARS)) {
      expect(RUNTIME_ONLY_VARS).toContain(key)
    }
  })

  test('stripRuntimeVars removes every desktop server var and keeps the rest', () => {
    const env: Record<string, string | undefined> = {
      ...DESKTOP_SERVER_VARS,
      HOME: '/home/user',
      NODE_ENV: 'development',
    }

    stripRuntimeVars(env)

    for (const key of Object.keys(DESKTOP_SERVER_VARS)) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.HOME).toBe('/home/user')
    expect(env.NODE_ENV).toBe('development')
  })

  test('the docker env path strips them too', () => {
    installDesktopServerEnv()
    try {
      // Exactly what sandboxExecAsync passes to `docker run` for the container.
      const dockerEnv = stripRuntimeVars(getSanitizedEnv())
      for (const key of Object.keys(DESKTOP_SERVER_VARS)) {
        expect(dockerEnv[key]).toBeUndefined()
      }
    } finally {
      restoreEnv()
    }
  })
})

describe('buildExecEnv', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-env-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    installDesktopServerEnv()
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    restoreEnv()
  })

  test('drops the desktop server vars and still injects RUNTIME_PORT + DATABASE_URL', () => {
    const env = buildExecEnv(workDir)

    for (const key of Object.keys(DESKTOP_SERVER_VARS)) {
      expect(env[key]).toBeUndefined()
    }
    // The runtime's own port stays available on purpose: exec commands curl
    // the preview API through it.
    expect(env.RUNTIME_PORT).toBe(process.env.PORT)
    expect(env.DATABASE_URL).toBe(`file:${join(workDir, 'prisma', 'dev.db')}`)
  })

  test('an API_PORT the user saved in the workspace .env still wins', () => {
    writeFileSync(join(workDir, '.env'), 'API_PORT=9999\n')

    expect(buildExecEnv(workDir).API_PORT).toBe('9999')
  })
})

describe('sandboxExec env isolation', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-env-isolation-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    installDesktopServerEnv()
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    restoreEnv()
  })

  test('a spawned shell sees none of the desktop app server vars', () => {
    const result = sandboxExec({
      command: ENV_PROBE,
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(result.exitCode).toBe(0)
    const seen = parseProbeLines(result.stdout)

    for (const key of Object.keys(DESKTOP_SERVER_VARS)) {
      expect(seen[key]).toBe('unset')
    }
    expect(seen.RUNTIME_PORT).not.toBe('unset')
    expect(seen.DATABASE_URL).toContain(workDir)
  })

  test('a workspace .env API_PORT is visible to the shell (strip runs before the merge)', () => {
    writeFileSync(join(workDir, '.env'), 'API_PORT=9999\n')

    const result = sandboxExec({
      command: 'echo "API_PORT=${API_PORT-unset}"',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    expect(parseProbeLines(result.stdout).API_PORT).toBe('9999')
  })
})
