// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-587 acceptance — QA gate.
//
// The dev's unit tests call the private helpers (`backgroundSetupMetro`,
// `runExpoExportWeb` mocked). These go through the entry points a published pod
// actually uses — `PreviewManager.start()` (kicked off by
// `initializePublished()` in `server.ts`) and `PreviewManager.buildForPublish()`
// (the `/agent/publish-build` route) — and join the exporter to the failure
// code, so a break in the wiring between them fails here even when both halves
// still pass on their own.
//
// Criterion -> test:
//   AC1  a published Expo pod on the artifact never runs `expo export`
//   AC3  a published pod without the signal exports *after* the API
//   AC4  a broken export is `build_failed` with the real stderr line (NOT
//        `build_oom` — exit 7 in the field is a permissions crash), only real
//        memory pressure is `build_oom`, and in a published pod Expo's home
//        directory is a tree the pod owns

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewManager } from '../preview-manager'

let dir: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['SHOGO_PUBLISHED_MODE', 'SHOGO_PUBLISHED_WEB', 'SHOGO_PREBUILT_IMAGE'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  dir = mkdtempSync(join(tmpdir(), 'qa-sho587-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'samsara-app' }))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for the project's `expo` bin that records every spawn. */
function installFakeExpo(script: string): string {
  const binDir = join(dir, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const marker = join(dir, 'expo-ran')
  const bin = join(binDir, 'expo')
  writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\n${script}\n`)
  chmodSync(bin, 0o755)
  return marker
}

/**
 * A PreviewManager on a metro project, with the setup steps the pod's boot does
 * not exercise under test (install, prisma) stubbed out. `startApiServer` is
 * recorded in `calls` at the moment it is invoked, so a test can prove what was
 * already on disk when the API came up.
 */
function mkPublishedPod() {
  const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38312 })
  const calls: string[] = []
  ;(pm as any).resolveDevServer = () => 'metro'
  ;(pm as any).projectProcessEnv = async () => ({})
  ;(pm as any).installDepsIfNeeded = async () => {
    calls.push('install')
  }
  ;(pm as any).runPrismaIfNeeded = async () => {
    calls.push('prisma')
  }
  ;(pm as any).startApiServer = async () => {
    calls.push('api')
  }
  return { pm, calls }
}

async function waitForReady(pm: PreviewManager, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((pm as any)._phase === 'ready') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`preview never reached ready (phase=${(pm as any)._phase})`)
}

describe('SHO-587 AC1 — a published pod with the artifact never exports', () => {
  it('starts server.tsx and reaches ready with the fake expo bin never spawned', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    process.env.SHOGO_PUBLISHED_WEB = 'artifact'
    // Exit 7 is the field failure: if this bin runs at all, the boot is broken.
    const marker = installFakeExpo('exit 7')
    const { pm, calls } = mkPublishedPod()

    const result = await pm.start()
    await waitForReady(pm)

    expect(result.mode).toBe('metro-web (background)')
    expect(existsSync(marker)).toBe(false)
    expect(calls).toEqual(['install', 'prisma', 'api'])
    expect((pm as any).lastSetupError).toBeNull()
  })

  it('an image-booted pod also skips install and prisma, and still runs the API', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    process.env.SHOGO_PUBLISHED_WEB = 'artifact'
    process.env.SHOGO_PREBUILT_IMAGE = 'true'
    const marker = installFakeExpo('exit 7')
    const { pm, calls } = mkPublishedPod()

    await pm.start()
    await waitForReady(pm)

    expect(existsSync(marker)).toBe(false)
    expect(calls).toEqual(['api'])
  })
})

describe('SHO-587 AC3 — a pod without the signal exports after the API', () => {
  it('brings the API up first, then exports, and stays ready when the export fails', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    const marker = installFakeExpo('exit 7')
    const { pm } = mkPublishedPod()
    const order: string[] = []
    ;(pm as any).startApiServer = async () => {
      order.push(existsSync(marker) ? 'api-after-export' : 'api-before-export')
    }

    await pm.start()
    await waitForReady(pm)

    expect(order).toEqual(['api-before-export'])
    expect(existsSync(marker)).toBe(true)
    expect((pm as any).lastSetupError).toBeNull()
  })
})

describe('SHO-587 AC4 — the publish build reports the export’s real cause', () => {
  function mkPublisher() {
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38313 })
    ;(pm as any).resolveDevServer = () => 'metro'
    ;(pm as any).projectProcessEnv = async () => ({})
    ;(pm as any).installDepsIfNeeded = async () => {}
    ;(pm as any).runPrismaIfNeeded = async () => {}
    return pm
  }

  it('exit 7 with the pod’s EACCES on stderr is build_failed, not build_oom', async () => {
    installFakeExpo(
      [
        'echo "EACCES: permission denied, mkdir \'/app/.expo\'" >&2',
        'echo "Node.js process exited with exit status: 7" >&2',
        'exit 7',
      ].join('\n'),
    )

    const result = await mkPublisher().buildForPublish()

    expect(result.ok).toBe(false)
    // code=7 in the field is a permissions crash (Expo telemetry writing into a
    // root-owned $HOME), never an OOM kill — telling the user to raise the
    // instance size would send them the wrong way (Shogo, 2026-11-25).
    expect(result.code).toBe('build_failed')
    expect(result.error).toContain('expo export failed (exit 7)')
    expect(result.error).toContain('EACCES: permission denied')
    expect(result.error).not.toContain('out of memory')
  })

  it('a kill signal alone is not an OOM: the build is build_failed, not build_oom', async () => {
    installFakeExpo('kill -9 $$')

    const result = await mkPublisher().buildForPublish()

    expect(result.ok).toBe(false)
    // SIGKILL is also what an operator, a crash-handler or the kernel's
    // cold-start reaper leaves behind — only a moved `oom_kill` counter or V8's
    // own heap message may claim memory pressure (Shogo, 2026-11-25).
    expect(result.code).toBe('build_failed')
    expect(result.error).toContain('killed (SIGKILL)')
    expect(result.error).not.toContain('out of memory')
  })

  it('a heap exhaustion the process reports itself is build_oom', async () => {
    installFakeExpo(
      ['echo "<--- Last few GCs --->"', 'echo "FATAL ERROR: Reached heap limit Allocation failed" >&2', 'exit 134'].join(
        '\n',
      ),
    )

    const result = await mkPublisher().buildForPublish()

    expect(result.ok).toBe(false)
    expect(result.code).toBe('build_oom')
    expect(result.error).toContain('out of memory')
    expect(result.error).toContain('Reached heap limit')
  })
})

describe('SHO-587 — Expo’s home directory inside a published pod', () => {
  it('hands the export a workspace-owned HOME instead of the image’s /app', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    const savedHome = process.env.HOME
    // What `packages/agent-runtime/Dockerfile` sets: HOME=/app, root-owned,
    // while the pod runs as appuser. Expo's `~/.expo` write is the EACCES that
    // turned into exit 7 (SHO-587, prod 2026-11-25).
    process.env.HOME = '/app'
    const binEnvFile = join(dir, 'child-env.txt')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    const bin = join(dir, 'node_modules', '.bin', 'expo')
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$HOME" "\${EXPO_NO_TELEMETRY-unset}" "\${__UNSAFE_EXPO_HOME_DIRECTORY-unset}" > "${binEnvFile}"\nexit 1\n`,
    )
    chmodSync(bin, 0o755)

    try {
      const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38314 })
      ;(pm as any).projectProcessEnv = async (extra: Record<string, string>) => ({
        ...(process.env as Record<string, string>),
        ...extra,
      })

      await (pm as any)._runExpoExportWebImpl({}, dir, { promote: false })

      const [home, telemetry, unsafeHome] = readFileSync(binEnvFile, 'utf8').trim().split('|')
      const expoHome = join(dir, '.shogo', 'expo-home')
      expect(home).toBe(expoHome)
      expect(existsSync(expoHome)).toBe(true)
      expect(telemetry).toBe('1')
      expect(unsafeHome).toBe(expoHome)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})
