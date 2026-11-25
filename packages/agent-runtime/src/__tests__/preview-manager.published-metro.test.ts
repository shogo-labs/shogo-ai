// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-587: a published Expo app's pages are built once, on the editing runtime
// at publish, and served from the bucket by the `*.shogo.one` Worker. The
// published pod only has to answer `/api/*`, so it must not run `expo export` —
// a cold Metro export needs ~2 GB and OOM-killed a size-`s` VM before
// `server.tsx` ever started, leaving every `/api/*` at 404 behind a 503.
//
// These cover the boot decision (`publishedMetroBootPlan`), the two metro boot
// orders, and the export's failure report (exit signal + stderr tail + OOM).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PreviewManager,
  expoExportRanOutOfMemory,
  publishedMetroBootPlan,
} from '../preview-manager'

let dir: string
const savedEnv: Record<string, string | undefined> = {}

const ENV_KEYS = ['SHOGO_PUBLISHED_MODE', 'SHOGO_PUBLISHED_WEB', 'SHOGO_PREBUILT_IMAGE'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  dir = mkdtempSync(join(tmpdir(), 'pm-published-metro-'))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for `expo` that records that it ran and then fails. */
function installFakeExpo(cwd: string, script: string): { bin: string; marker: string } {
  const binDir = join(cwd, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const marker = join(cwd, 'expo-ran')
  const bin = join(binDir, 'expo')
  writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\n${script}\n`)
  chmodSync(bin, 0o755)
  return { bin, marker }
}

function mkMetro() {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
  const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38310 })
  ;(pm as any).resolveDevServer = () => 'metro'
  ;(pm as any).projectProcessEnv = async () => ({})
  const calls: string[] = []
  ;(pm as any).installDepsIfNeeded = async () => {
    calls.push('install')
  }
  ;(pm as any).runPrismaIfNeeded = async () => {
    calls.push('prisma')
  }
  return { pm, calls }
}

describe('publishedMetroBootPlan', () => {
  it('not published: export, then the API (the canvas serves dist/)', () => {
    expect(publishedMetroBootPlan({})).toEqual({
      published: false,
      exportWeb: true,
      installDeps: true,
      apiFirst: false,
    })
  })

  it('published + artifact: no export, no install for an image, API first', () => {
    expect(
      publishedMetroBootPlan({ SHOGO_PUBLISHED_MODE: 'true', SHOGO_PUBLISHED_WEB: 'artifact' }),
    ).toEqual({ published: true, exportWeb: false, installDeps: true, apiFirst: true })
  })

  it('published + artifact from a per-commit image: no export, no install', () => {
    expect(
      publishedMetroBootPlan({
        SHOGO_PUBLISHED_MODE: 'true',
        SHOGO_PUBLISHED_WEB: 'artifact',
        SHOGO_PREBUILT_IMAGE: 'true',
      }),
    ).toEqual({ published: true, exportWeb: false, installDeps: false, apiFirst: true })
  })

  it('published without the artifact signal: exports, but after the API', () => {
    expect(publishedMetroBootPlan({ SHOGO_PUBLISHED_MODE: 'true' })).toEqual({
      published: true,
      exportWeb: true,
      installDeps: true,
      apiFirst: true,
    })
  })
})

describe('published metro boot', () => {
  it('never spawns expo when the publish artifact exists', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    process.env.SHOGO_PUBLISHED_WEB = 'artifact'
    const { marker } = installFakeExpo(dir, 'exit 7')
    const { pm, calls } = mkMetro()
    ;(pm as any).startApiServer = async () => {
      calls.push('api')
    }

    await (pm as any).backgroundSetupMetro({}, dir)

    expect(existsSync(marker)).toBe(false)
    expect(calls).toEqual(['install', 'prisma', 'api'])
    expect((pm as any)._phase).toBe('ready')
    expect((pm as any).started).toBe(true)
  })

  it('brings the API up before a legacy boot export, so a failed export cannot 404 it', async () => {
    process.env.SHOGO_PUBLISHED_MODE = 'true'
    const { marker } = installFakeExpo(dir, 'exit 7')
    const { pm, calls } = mkMetro()
    ;(pm as any).startApiServer = async () => {
      calls.push(existsSync(marker) ? 'api-after-export' : 'api')
    }

    await (pm as any).backgroundSetupMetro({}, dir)

    expect(existsSync(marker)).toBe(true)
    // install → prisma → api → export, and the failed export is not fatal.
    expect(calls).toEqual(['install', 'prisma', 'api'])
    expect((pm as any)._phase).toBe('ready')
  })

  it('leaves the editing preview order alone: export first, then the API', async () => {
    const { marker } = installFakeExpo(dir, 'exit 0')
    const { pm, calls } = mkMetro()
    ;(pm as any).startApiServer = async () => {
      calls.push(existsSync(marker) ? 'api-after-export' : 'api')
    }

    await (pm as any).backgroundSetupMetro({}, dir)

    expect(calls).toEqual(['install', 'prisma', 'api-after-export'])
  })
})

describe('_runExpoExportWebImpl — failure report', () => {
  function mkExporter(published = false) {
    if (published) process.env.SHOGO_PUBLISHED_MODE = 'true'
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38311 })
    ;(pm as any).projectProcessEnv = async () => ({})
    return pm
  }

  it('keeps the stderr tail and exit code of a broken export', async () => {
    installFakeExpo(
      dir,
      ['echo "Metro: Unexpected token, expected \\",\\" (3:12)" >&2', 'exit 1'].join('\n'),
    )

    const result = await (mkExporter() as any)._runExpoExportWebImpl({}, dir, { promote: false })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderrTail).toContain('Unexpected token')
    expect(result.oom).toBe(false)
  })

  it('does not call a signal death out of memory: the EACCES exit 7 Samsara hit', async () => {
    // The real prod failure: Expo telemetry writing into a root-owned HOME.
    // code=7 is not memory pressure — the cgroup's oom_kill stayed at 0.
    installFakeExpo(
      dir,
      ['echo "EACCES: permission denied, mkdir \'/app/.expo\'" >&2', 'exit 7'].join('\n'),
    )

    const result = await (mkExporter() as any)._runExpoExportWebImpl({}, dir, { promote: false })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(7)
    expect(result.stderrTail).toContain("EACCES: permission denied, mkdir '/app/.expo'")
    expect(result.oom).toBe(false)
  })

  it('does not infer memory pressure from SIGKILL alone', async () => {
    installFakeExpo(dir, 'kill -9 $$')

    const result = await (mkExporter() as any)._runExpoExportWebImpl({}, dir, { promote: false })

    expect(result.ok).toBe(false)
    expect(result.signal).toBe('SIGKILL')
    expect(result.oom).toBe(false)
  })

  it('reports heap exhaustion from the build output', async () => {
    installFakeExpo(
      dir,
      ['echo "<--- Last few GCs --->"', 'echo "FATAL ERROR: Reached heap limit Allocation failed" >&2', 'exit 134'].join(
        '\n',
      ),
    )

    const result = await (mkExporter() as any)._runExpoExportWebImpl({}, dir, { promote: false })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(134)
    expect(result.stderrTail).toContain('Reached heap limit')
    expect(result.oom).toBe(true)
  })

  it('keeps Expo out of a root-owned HOME in a published pod', async () => {
    let exportEnv: Record<string, string> | undefined
    const pm = mkExporter(true)
    ;(pm as any).projectProcessEnv = async (extra: Record<string, string>) => {
      exportEnv = extra
      return {}
    }
    installFakeExpo(dir, 'exit 1')

    await (pm as any)._runExpoExportWebImpl({}, dir, { promote: false })

    const expoHome = join(dir, '.shogo', 'expo-home')
    expect(exportEnv?.EXPO_NO_TELEMETRY).toBe('1')
    expect(exportEnv?.HOME).toBe(expoHome)
    expect(exportEnv?.__UNSAFE_EXPO_HOME_DIRECTORY).toBe(expoHome)
    expect(existsSync(expoHome)).toBe(true)
  })

  it('leaves the editing preview on its own writable HOME', async () => {
    let exportEnv: Record<string, string> | undefined
    const pm = mkExporter()
    ;(pm as any).projectProcessEnv = async (extra: Record<string, string>) => {
      exportEnv = extra
      return {}
    }
    installFakeExpo(dir, 'exit 1')

    await (pm as any)._runExpoExportWebImpl({}, dir, { promote: false })

    expect(exportEnv?.EXPO_NO_TELEMETRY).toBe('1')
    expect(exportEnv?.HOME).toBeUndefined()
  })
})

describe('expoExportRanOutOfMemory', () => {
  it('trusts the kernel counter', () => {
    expect(expoExportRanOutOfMemory({ oomKillDelta: 1, output: '' })).toBe(true)
    expect(expoExportRanOutOfMemory({ oomKillDelta: 0, output: '' })).toBe(false)
  })

  it('trusts V8 when the kernel does not report it', () => {
    const v8 = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
    expect(expoExportRanOutOfMemory({ oomKillDelta: null, output: v8 })).toBe(true)
  })

  it('treats a permission error as an ordinary build failure', () => {
    expect(
      expoExportRanOutOfMemory({
        oomKillDelta: 0,
        output: "EACCES: permission denied, mkdir '/app/.expo'",
      }),
    ).toBe(false)
  })
})
