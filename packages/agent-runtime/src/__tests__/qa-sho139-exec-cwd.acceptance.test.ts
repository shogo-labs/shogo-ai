// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-139 acceptance — QA.
 *
 * Russell's report: "when a user has shogo working in a repo it keeps creating
 * .shogo-cwd files — these should not exist … and why are they in the root
 * folder". The card's acceptance criteria are measured here through the real
 * `exec` / `exec_wait` / `task_cancel` tools, not the helpers the dev added:
 *
 *   1. a `background: true` exec nobody waits on leaves no marker
 *   2. a soft-timeout run and a `task_cancel`ed run leave no marker
 *   3. foreground success and failure still return the final cwd and leave
 *      nothing; `wait` still applies a background task's final cwd
 *   4. in a folder-linked-style git repo (no managed exclude block) a
 *      background exec leaves `git status --porcelain` clean
 *   5. the sweep removes stale markers and keeps fresh ones, at the root and
 *      under `.shogo/exec-cwd/`
 *   6. the sandbox path maps to `/workspace/.shogo/exec-cwd/<marker>` and back
 *   7. `exec` still works when `.shogo/` cannot be created (fallback path)
 *
 * Pre-fix these fail: the marker is written to the workspace root and only the
 * foreground / `wait` drain paths unlink it, so 1, 2 and 4 see a leftover file.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, beforeAll } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools, hostToContainer, containerToHost, type ToolContext } from '../gateway-tools'
import { TaskRegistry } from '../task-registry'
import { taskOutputDir } from '../task-output'
import { EXEC_CWD_DIR, EXEC_CWD_PREFIX, sweepExecCwdMarkers } from '../exec-cwd'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

// Realpath the tmp root: on macOS `/tmp` is a symlink to `/private/tmp`, and
// the runtime-trust allow-list compares realpaths.
const TMP_ROOT = realpathSync(tmpdir())
let TEST_DIR = ''
let REAL_TEST_DIR = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const cwdRef = { cwd: REAL_TEST_DIR }
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } } as any,
    projectId: 'qa-sho139',
    sessionId: 'qa-sho139-session',
    shellState: {
      getCwd: () => cwdRef.cwd,
      setCwd: (cwd: string) => {
        cwdRef.cwd = cwd
      },
    },
    ...overrides,
  } as ToolContext
}

async function run(ctx: ToolContext, name: string, params: Record<string, any> = {}) {
  const tool = createTools(ctx).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return (await tool.execute('qa-call', params)).details as any
}

function newRegistry() {
  return new TaskRegistry({ outputDir: taskOutputDir(TEST_DIR, 'chat-1'), workspaceDir: TEST_DIR })
}

/** Every cwd marker on disk, at the workspace root and under `.shogo/exec-cwd/`. */
function leftoverMarkers(): string[] {
  const found: string[] = []
  for (const dir of [TEST_DIR, join(TEST_DIR, EXEC_CWD_DIR)]) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(EXEC_CWD_PREFIX)) found.push(join(dir, name))
      }
    } catch {
      /* directory absent — nothing to find */
    }
  }
  return found
}

/** Wait for a task to leave `running` without draining its result (no `wait`). */
async function settle(registry: TaskRegistry, taskId: string) {
  const deadline = Date.now() + 15_000
  while (registry.get(taskId)?.status === 'running') {
    if (Date.now() > deadline) throw new Error(`task ${taskId} never finished`)
    await sleep(25)
  }
  // The exit-time capture runs off `handle.done`, next to the registry settle.
  await sleep(75)
}

describe('SHO-139 acceptance — exec leaves no cwd marker behind', () => {
  beforeAll(() => {
    TEST_DIR = mkdtempSync(join(TMP_ROOT, 'qa-sho139-'))
    REAL_TEST_DIR = realpathSync(TEST_DIR)
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => {
    clearTrustForTests()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    for (const name of readdirSync(TEST_DIR)) rmSync(join(TEST_DIR, name), { recursive: true, force: true })
  })

  // --- AC1 -----------------------------------------------------------------
  test('AC1: a background exec nobody waits on leaves no marker anywhere', async () => {
    const registry = newRegistry()
    const ctx = createCtx({ commandRegistry: registry })

    const started = await run(ctx, 'exec', { command: 'sleep 0.2; echo done', background: true })
    expect(started.status).toBe('running')

    await settle(registry, started.task_id)
    expect(registry.get(started.task_id)?.status).toBe('completed')
    expect(leftoverMarkers()).toEqual([])
  })

  // --- AC2 -----------------------------------------------------------------
  test('AC2: a soft-timeout run leaves no marker', async () => {
    const registry = newRegistry()
    const ctx = createCtx({ commandRegistry: registry })

    const started = await run(ctx, 'exec', { command: 'sleep 0.6', timeout: 50 })
    expect(started.status).toBe('running')

    await settle(registry, started.task_id)
    expect(leftoverMarkers()).toEqual([])
  })

  test('AC2: a task_cancel-ed run leaves no marker', async () => {
    const registry = newRegistry()
    const ctx = createCtx({ commandRegistry: registry })

    const started = await run(ctx, 'exec', { command: 'sleep 30', background: true })
    await run(ctx, 'task_cancel', { task_id: started.task_id })

    await settle(registry, started.task_id)
    expect(leftoverMarkers()).toEqual([])
  })

  // --- AC3 -----------------------------------------------------------------
  test('AC3: foreground success returns the final cwd and leaves nothing', async () => {
    mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
    const ctx = createCtx()

    const result = await run(ctx, 'exec', { command: 'cd subdir' })
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe(join(REAL_TEST_DIR, 'subdir'))
    expect(leftoverMarkers()).toEqual([])

    const pwd = await run(ctx, 'exec', { command: 'pwd' })
    expect(pwd.stdout).toBe(join(REAL_TEST_DIR, 'subdir'))
    expect(leftoverMarkers()).toEqual([])
  })

  test('AC3: foreground failure reports the exit code and leaves nothing', async () => {
    const ctx = createCtx()
    const result = await run(ctx, 'exec', { command: 'exit 3' })
    expect(result.exitCode).toBe(3)
    expect(leftoverMarkers()).toEqual([])
  })

  test('AC3: wait on a background task still moves the shell to its final cwd', async () => {
    mkdirSync(join(TEST_DIR, 'bgdir'), { recursive: true })
    const registry = newRegistry()
    const ctx = createCtx({ commandRegistry: registry })

    const started = await run(ctx, 'exec', { command: 'cd bgdir', background: true })
    const waited = await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 10_000 })
    expect(waited.status ?? 'completed').not.toBe('running')
    expect(ctx.shellState!.getCwd()).toBe(join(REAL_TEST_DIR, 'bgdir'))
    expect(leftoverMarkers()).toEqual([])
  })

  // --- AC4 -----------------------------------------------------------------
  test('AC4: a background exec in a folder-linked-style repo leaves git status clean', async () => {
    // A repo Shogo did not create: no `.gitignore`, no managed exclude block.
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: TEST_DIR })
    writeFileSync(join(TEST_DIR, 'README.md'), '# user repo\n')
    execFileSync('git', ['add', '-A'], { cwd: TEST_DIR })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: TEST_DIR })

    // Task logs live under `.shogo/tasks/` and are covered by Shogo's default
    // workspace `.gitignore`; keep them outside the repo so this measures only
    // what `exec` itself leaves in the tree.
    const registry = new TaskRegistry({
      outputDir: mkdtempSync(join(TMP_ROOT, 'qa-sho139-logs-')),
      workspaceDir: TEST_DIR,
    })
    const ctx = createCtx({ commandRegistry: registry })
    const started = await run(ctx, 'exec', { command: 'sleep 0.2', background: true })
    await settle(registry, started.task_id)

    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: TEST_DIR,
      encoding: 'utf-8',
    })
    // git says nothing about an empty directory, so a marker that is written
    // and collected inside `.shogo/exec-cwd/` cannot show up at all.
    expect(status).toBe('')
    expect(leftoverMarkers()).toEqual([])
  })

  // --- AC5 -----------------------------------------------------------------
  test('AC5: the sweep drops stale markers and keeps a fresh one', async () => {
    const nested = join(TEST_DIR, EXEC_CWD_DIR)
    mkdirSync(nested, { recursive: true })
    const staleRoot = join(TEST_DIR, `${EXEC_CWD_PREFIX}1600000000000-stale`)
    const staleNested = join(nested, `${EXEC_CWD_PREFIX}1600000000001-stale`)
    const fresh = join(nested, `${EXEC_CWD_PREFIX}${Date.now()}-fresh`)
    const old = new Date(Date.now() - 20 * 60 * 1000)
    for (const f of [staleRoot, staleNested, fresh]) writeFileSync(f, '/some/cwd\n')
    utimesSync(staleRoot, old, old)
    utimesSync(staleNested, old, old)

    const removed = sweepExecCwdMarkers(TEST_DIR)

    expect(removed).toBe(2)
    expect(leftoverMarkers()).toEqual([fresh])
  })

  // --- AC6 -----------------------------------------------------------------
  test('AC6: the marker path maps both ways through the sandbox mount', () => {
    const host = join(REAL_TEST_DIR, EXEC_CWD_DIR, `${EXEC_CWD_PREFIX}1234-abc`)
    expect(hostToContainer(host, REAL_TEST_DIR)).toBe(`/workspace/${EXEC_CWD_DIR}/${EXEC_CWD_PREFIX}1234-abc`)
    expect(containerToHost(`/workspace/${EXEC_CWD_DIR}/${EXEC_CWD_PREFIX}1234-abc`, REAL_TEST_DIR)).toBe(host)
  })

  // --- AC7 (fallback, not stated in the card but load-bearing) --------------
  test('exec still captures cwd when .shogo cannot be created', async () => {
    mkdirSync(join(TEST_DIR, 'sub2'), { recursive: true })
    writeFileSync(join(TEST_DIR, '.shogo'), 'not a directory\n')
    const ctx = createCtx()

    const result = await run(ctx, 'exec', { command: 'cd sub2' })
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe(join(REAL_TEST_DIR, 'sub2'))
    // Falls back to the old root path — still consumed, nothing left behind.
    expect(leftoverMarkers()).toEqual([])
    expect(statSync(join(TEST_DIR, '.shogo')).isFile()).toBe(true)
  })
})
