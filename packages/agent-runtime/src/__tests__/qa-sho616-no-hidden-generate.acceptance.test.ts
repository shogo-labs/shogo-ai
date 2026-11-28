// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-616 — QA acceptance, one block per criterion on the card.
 *
 * AC1  A monorepo checkout never generates: `/api`-facing paths (`ensure`,
 *      sidecar start, schema watcher, recovery, `sync`) spawn nothing, log the
 *      skip once and report `phase: 'none'`. Asserted against the *real*
 *      `shogo.config.json` at the repo root, so a future edit that adds a
 *      `server` output there fails here instead of silently re-arming codegen
 *      inside every agent checkout.
 * AC2  No `generate` script and no SDK CLI → no process at all, `bun install`
 *      named in the error.
 * AC3  A timed-out generate kills the whole tree and settles within the 5 s
 *      backstop; the manager is `crashed`, not stuck `generating`.
 * AC4  The worker's default `chat` command refuses every SDK subcommand name
 *      (exit 2, no `✗` = `runAgent` never ran); `-p` and multi-word prompts are
 *      untouched.
 * AC5  No agent-facing text recommends `bun x shogo generate`, and the shipped
 *      guidance does name `bun run generate` — a deletion alone must not pass.
 *
 * Fail-on-`main`: AC1/AC2/AC3 fail against main's `preview-manager.ts`
 * (it fell through to `bun x shogo generate`), AC4 fails against main's
 * `cli.ts` (exit 1 from a real agent attempt), AC5 fails on the five prompt
 * strings the fix rewrote.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** #1 source of `shogo generate` spawns; swapped for a recording script. */
let bunBinary = 'bun'

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    get bunBinary() {
      return bunBinary
    },
    prismaGenerateAsync: async () => {},
    prismaDbPushAsync: async () => {},
  },
  resolveBinInvocation: () => null,
}))

import { PreviewManager } from '../preview-manager'
import { emitsServerEntry } from '../shogo-app-project'
import { CANVAS_V2_PROMPT } from '../canvas-v2-prompt'
import { buildCodeAgentGeneralGuide } from '../code-agent-prompt'

/** `packages/agent-runtime/src/__tests__` → repo root. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const WORKER_CLI = join(REPO_ROOT, 'packages', 'shogo-worker', 'src', 'cli.ts')

let dir: string
const managers: any[] = []
let home: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho616-'))
  home = mkdtempSync(join(tmpdir(), 'qa-sho616-home-'))
  bunBinary = 'bun'
})

afterEach(() => {
  for (const m of managers) {
    try {
      m.stopSchemaWatcher?.()
    } catch {}
  }
  managers.length = 0
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function manager(cwd: string, extra: Record<string, unknown> = {}): any {
  const m = new PreviewManager({
    workspaceDir: cwd,
    runtimePort: 38401,
    publicUrl: 'https://preview.example/qa-sho616',
    localMode: false,
    apiPort: 38402,
    ...extra,
  }) as any
  managers.push(m)
  return m
}

/**
 * A `bun` that records its argv and then runs `body`. Absence of the marker
 * file proves nothing was spawned at all.
 */
function fakeBun(body: string): string {
  const marker = join(dir, 'spawned-args.txt')
  const path = join(dir, 'fake-bun.sh')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n${body}\n`, 'utf-8')
  chmodSync(path, 0o755)
  bunBinary = path
  return marker
}

/** A generated-file-free app folder: `package.json` + `prisma/schema.prisma`. */
function project(files: Record<string, string> = {}): string {
  const p = join(dir, 'project')
  mkdirSync(join(p, 'prisma'), { recursive: true })
  writeFileSync(
    join(p, 'package.json'),
    JSON.stringify({ name: 'qa-sho616', ...JSON.parse(files['package.json'] ?? '{}') }),
  )
  writeFileSync(join(p, 'prisma/schema.prisma'), 'model User {\n  id Int @id\n}\n')
  for (const [name, body] of Object.entries(files)) {
    if (name === 'package.json') continue
    writeFileSync(join(p, name), body)
  }
  return p
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('AC1 — a monorepo checkout is not an app project', () => {
  it('the real repo-root shogo.config.json emits no server entry', () => {
    // Anti-drift pin: adding a `server` output at the monorepo root turns every
    // agent checkout back into an API-sidecar project (and, before the fix,
    // into `bun x shogo generate` → global worker → paid agent turn).
    expect(existsSync(join(REPO_ROOT, 'shogo.config.json'))).toBe(true)
    expect(emitsServerEntry(REPO_ROOT)).toBe(false)
  })

  it('an /api request spawns no codegen, logs the skip once and reports none', async () => {
    const marker = fakeBun(':')
    const m = manager(REPO_ROOT)
    let generated = 0
    const real = m.runShogoGenerate.bind(m)
    m.runShogoGenerate = async () => {
      generated += 1
      return real()
    }
    const log = spyOn(console, 'log')

    try {
      // The order an `/api` request and an agent turn drive it in.
      await m.startApiServer()
      await m.ensureApiServer({ timeoutMs: 2_000 })
      m.startSchemaWatcher()
      expect(m.maybeRecoverApiServer()).toBe(false)
      const synced = await m.sync()

      expect(generated).toBe(0)
      expect(existsSync(marker)).toBe(false)
      expect(synced.ok).toBe(false)
      expect(synced.error).toContain('not a Shogo app project')
      expect(m.apiServerPhase).toBe('idle')
      expect((await m.apiServerStatus()).phase).toBe('none')
      expect(m.hasApiServer).toBe(false)

      const skipLines = log.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((line: string) => line.includes('API sidecar skipped'))
      expect(skipLines).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  }, 30_000)
})

describe('AC2 — no script, no SDK CLI, no process', () => {
  it('returns false with the bun-install error and spawns nothing', async () => {
    project()
    const marker = fakeBun(':')
    const m = manager(dir)

    const ok = await m.runShogoGenerate()

    expect(ok).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(m.apiLastGenerateError).toContain('cli.mjs')
    expect(m.apiLastGenerateError).toContain('bun install')
    // No `bun x shogo` fallback may come back: the old path is what left the
    // global worker to read "generate" as a prompt.
    expect(m.apiLastGenerateError).not.toContain('bun x shogo')
    expect(m.apiServerPhase).toBe('crashed')
  })
})

describe('AC3 — a timed-out generate leaves no survivors', () => {
  it('kills the tree, settles inside the backstop and reports crashed', async () => {
    project({ 'package.json': JSON.stringify({ scripts: { generate: 'sh' } }) })
    const pidFile = join(dir, 'grandchild.pid')
    // Leader forks a grandchild that inherits the stdio pipes and outlives it —
    // the `failed after 446.4s (exit=null)` shape from the card.
    fakeBun(`sleep 600 &\necho $! > '${pidFile}'\nwait`)
    const m = manager(dir, { generateTimeoutMs: 1_000 })

    const started = Date.now()
    const ok = await m.runShogoGenerate()
    const elapsed = Date.now() - started

    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(1_000 + 5_000)
    expect(m.apiLastGenerateError).toContain('timed out')
    // Not wedged in `generating` — `maybeRecoverApiServer` must see `crashed`.
    expect(m.apiServerPhase).toBe('crashed')

    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(Number.isFinite(grandchild)).toBe(true)
    expect(pidAlive(grandchild)).toBe(false)
  }, 20_000)
})

describe('AC4 — the worker refuses a lone SDK subcommand', () => {
  function runCli(args: string[]) {
    const res = spawnSync(process.execPath, ['--conditions=development', WORKER_CLI, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SHOGO_API_KEY: '',
        SHOGO_CLOUD_URL: '',
        SHOGO_RUNTIME_BIN: '',
      },
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  for (const word of ['generate', 'deploy', 'bucket', '3d']) {
    it(`\`shogo ${word}\` exits 2 without starting an agent turn`, () => {
      const { status, stdout, stderr } = runCli([word])

      expect(status).toBe(2)
      expect(stderr).toContain('is a @shogo-ai/sdk command, not a prompt')
      expect(stderr).toContain(`shogo -p ${word}`)
      // `handle()`'s failure prefix only appears once `runAgent` was reached.
      expect(stderr).not.toContain('✗')
      expect(stdout).toBe('')
    }, 60_000)
  }

  it('multi-word and `-p` prompts still reach the agent', () => {
    const multi = runCli(['generate', 'the', 'weekly', 'report'])
    expect(multi.status).not.toBe(2)
    expect(multi.stderr).not.toContain('is a @shogo-ai/sdk command, not a prompt')

    const explicit = runCli(['-p', 'generate'])
    expect(explicit.status).not.toBe(2)
    expect(explicit.stderr).not.toContain('is a @shogo-ai/sdk command, not a prompt')
  }, 60_000)
})

describe('AC5 — agent-facing text', () => {
  const shippedFiles = [
    'templates/runtime-template/scripts/generate.ts',
    'packages/agent-runtime/tech-stacks/expo-app/starter/scripts/generate.ts',
    'packages/agent-runtime/tech-stacks/expo-three/starter/scripts/generate.ts',
    'packages/agent-runtime/tech-stacks/react-native/starter/scripts/generate.ts',
    'packages/agent-runtime/tech-stacks/react-native/starter/README.md',
    'packages/sdk/src/generators/custom-routes.ts',
  ]

  for (const file of shippedFiles) {
    it(`${file} says bun run generate`, () => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8')
      expect(text).not.toMatch(/bun ?x shogo|bunx shogo/)
    })
  }

  it('the composed prompts never send an agent to `bun x shogo generate`', () => {
    const prompts = [CANVAS_V2_PROMPT, buildCodeAgentGeneralGuide(false, false)].join('\n')

    expect(prompts).not.toContain('bun x shogo')
    expect(prompts).not.toContain('bunx shogo')
    // The replacement must actually be there — deleting the line is not a fix.
    expect(prompts).toContain('bun run generate')
  })
})
