// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-209 acceptance — QA.
 *
 * Russell: "why is rm blocked? no commands should be blocked by us by default."
 * The card's criteria are measured here through the real `exec` tool gated by a
 * real `PermissionEngine` built from `DEFAULT_SECURITY_PREFERENCE` (mode
 * `full_autonomy`, i.e. what a desktop runtime boots with) — not through the
 * helpers the dev added:
 *
 *   1. `rm -r <abs path>`, `rm -rf *.log`, a command containing `bash -c`,
 *      `sh -c`, `| sh`, and `git push --force-with-lease` all run without a
 *      "Permission denied" / "Blocked command"
 *   2. a shell deny rule a person configured still denies; strict mode still
 *      asks (and fails closed when nobody is there to answer)
 *   3. the gateway-kill and self-detach guards are untouched
 *   4. the exec description no longer claims destructive commands are blocked
 *
 * Pre-fix 1 fails on every command listed: `rm -r /…` matched the
 * `^\s*rm\s+-[a-z]*r[a-z]*\s+\//` sub-command pattern, and `bash -c`, `sh -c`,
 * `| sh` and `--force` matched the full-command patterns that are tested
 * against the whole string. `rm -rf *.log` hit the legacy `rm -rf *` substring
 * check in gateway-tools.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import {
  DEFAULT_SECURITY_PREFERENCE,
  PermissionEngine,
  type SecurityPreference,
} from '../permission-engine'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TMP_ROOT = realpathSync(tmpdir())
let TEST_DIR = ''
let OUTSIDE_DIR = ''

const DENIAL = /Permission denied|Blocked command|hard-blocked|destructive pattern/

function makeCtx(preference: SecurityPreference = DEFAULT_SECURITY_PREFERENCE): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'qa-sho209',
    commandRegistry: new CommandRegistry(),
    permissionEngine: new PermissionEngine({ workspaceDir: TEST_DIR, preference }),
  } as ToolContext
}

async function exec(ctx: ToolContext, params: Record<string, any>): Promise<any> {
  const tool = createTools(ctx).find((t) => t.name === 'exec')
  if (!tool) throw new Error('exec tool missing')
  const result: any = await tool.execute('qa-sho209-call', params)
  return result.details
}

/** A refusal returns `{ error }` and never spawns; a real run returns an exitCode. */
function expectRan(result: any): void {
  expect(String(result.error ?? '')).not.toMatch(DENIAL)
  expect(typeof result.exitCode).toBe('number')
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: TEST_DIR, stdio: 'ignore' })
}

describe('SHO-209 — no shell command is blocked by default', () => {
  beforeEach(() => {
    TEST_DIR = realpathSync(mkdtempSync(join(TMP_ROOT, 'qa-sho209-ws-')))
    OUTSIDE_DIR = realpathSync(mkdtempSync(join(TMP_ROOT, 'qa-sho209-abs-')))
    trustWorkspaceForTests(TEST_DIR, { linkedFolders: [OUTSIDE_DIR] })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    rmSync(OUTSIDE_DIR, { recursive: true, force: true })
  })

  afterAll(() => clearTrustForTests())

  test('AC1: `rm -r <absolute path>` outside the workspace runs', async () => {
    const target = join(OUTSIDE_DIR, 'shogo-rm-probe')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'file.txt'), 'x')

    const result = await exec(makeCtx(), { command: `rm -r ${target}` })

    expectRan(result)
    expect(result.exitCode).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  test('AC1: `rm -rf *.log` runs (legacy substring block gone)', async () => {
    writeFileSync(join(TEST_DIR, 'stale.log'), 'x')
    writeFileSync(join(TEST_DIR, 'keep.txt'), 'x')

    const result = await exec(makeCtx(), { command: 'rm -rf *.log' })

    expectRan(result)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(TEST_DIR, 'stale.log'))).toBe(false)
    expect(existsSync(join(TEST_DIR, 'keep.txt'))).toBe(true)
  })

  test('AC1: a command that merely contains `bash -c` runs (git grep)', async () => {
    git(['init', '-q'])
    writeFileSync(join(TEST_DIR, 'note.md'), 'run it with: bash -c "echo hi"\n')
    git(['add', 'note.md'])

    const result = await exec(makeCtx(), {
      command: 'git grep -n "bash -c" . > grep.out 2>&1',
    })

    expectRan(result)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(TEST_DIR, 'grep.out'), 'utf-8')).toContain('bash -c')
  })

  test('AC1: `sh -c` and `| sh` run', async () => {
    const shC = await exec(makeCtx(), { command: 'sh -c "touch sh-c-marker"' })
    expectRan(shC)
    expect(existsSync(join(TEST_DIR, 'sh-c-marker'))).toBe(true)

    const piped = await exec(makeCtx(), { command: `printf 'touch piped-marker\\n' | sh` })
    expectRan(piped)
    expect(existsSync(join(TEST_DIR, 'piped-marker'))).toBe(true)
  })

  test('AC1: `git push --force-with-lease` is allowed by the gate and reaches git', async () => {
    const engine = new PermissionEngine({ workspaceDir: TEST_DIR, preference: DEFAULT_SECURITY_PREFERENCE })
    expect(engine.check('shell', 'exec', { command: 'git push --force-with-lease' }).action).toBe('allow')

    git(['init', '-q'])
    writeFileSync(join(TEST_DIR, 'a.txt'), 'x')
    git(['add', 'a.txt'])
    git(['-c', 'user.name=Shogo Agent', '-c', 'user.email=agent@shogo.ai', 'commit', '-qm', 'init'])

    // No remote configured, so git itself fails — the point is that the
    // runtime did not refuse it before git ever ran.
    const result = await exec(makeCtx(), { command: 'git push --force-with-lease > push.out 2>&1' })
    expect(String(result.error ?? '')).not.toMatch(DENIAL)
    expect(typeof result.exitCode).toBe('number')
    expect(readFileSync(join(TEST_DIR, 'push.out'), 'utf-8').length).toBeGreaterThan(0)
  })

  test('AC2: a configured shell deny rule still denies, and nothing runs', async () => {
    const target = join(TEST_DIR, 'denied-dir')
    mkdirSync(target, { recursive: true })
    const ctx = makeCtx({
      mode: 'full_autonomy',
      approvalTimeoutSeconds: 30,
      overrides: { shellCommands: { deny: ['rm *'] } },
    } as SecurityPreference)

    const result = await exec(ctx, { command: `rm -r ${target}` })

    expect(String(result.error ?? '')).toContain('Permission denied')
    expect(existsSync(target)).toBe(true)
  })

  test('AC2: strict mode still asks, and fails closed with nobody to answer', async () => {
    const target = join(TEST_DIR, 'strict-dir')
    mkdirSync(target, { recursive: true })
    const ctx = makeCtx({ mode: 'strict', approvalTimeoutSeconds: 30 })

    const result = await exec(ctx, { command: `rm -r ${target}` })

    expect(String(result.error ?? '')).toMatch(/declined|Permission denied/)
    expect(existsSync(target)).toBe(true)
  })

  test('AC3: a pkill aimed at the runtime is still refused', async () => {
    const result = await exec(makeCtx(), { command: 'pkill -f bun' })
    expect(String(result.error ?? '')).toContain('runtime')
    expect(result.exitCode).toBeUndefined()
  })

  test('AC3: a self-detaching command is still refused and starts nothing', async () => {
    const result = await exec(makeCtx(), {
      command: `nohup touch ${join(TEST_DIR, 'detached-ran')} > export.log 2>&1 &`,
      background: true,
    })
    expect(String(result.error ?? '')).toContain('detaches itself')
    expect(result.exitCode).toBeUndefined()
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(join(TEST_DIR, 'detached-ran'))).toBe(false)
  })

  test('AC4: the exec description no longer promises destructive commands are blocked', () => {
    const tool = createTools(makeCtx()).find((t) => t.name === 'exec')
    expect(tool).toBeDefined()
    expect(tool!.description).not.toContain('Destructive commands are blocked')
    expect(tool!.description.toLowerCase()).not.toContain('blocked')
  })
})
