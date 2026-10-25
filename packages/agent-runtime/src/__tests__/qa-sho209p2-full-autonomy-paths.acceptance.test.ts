// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-209 Part 2 acceptance — QA.
 *
 * Russell: "in full autonomy we should block nothing including file paths."
 * Measured through the real file tools (`read_file` / `write_file` / `edit_file`
 * from `createTools()`) with a real `PermissionEngine`, not through the helpers
 * the fix added:
 *
 *   5. full_autonomy allows every `HARD_BLOCKED_PATH_PREFIXES` entry and the
 *      `system` category — verified without ever touching a real credential
 *      file (probe names that cannot exist, plus `/etc/passwd`, which is
 *      world-readable)
 *   6. a folder-linked desktop project (`SHOGO_LOCAL_MODE=true` +
 *      `LINKED_FOLDERS`) accepts read/write/edit outside the workspace and the
 *      linked folders — same as a plain local project
 *   7. strict/balanced still refuse both, exactly as on origin/main, and a
 *      configured `fileAccess.deny` still refuses in full_autonomy
 *   8. cloud is unchanged: a pod-shaped runtime (actionsOnly engine whose mode
 *      is still `full_autonomy`, no `SHOGO_LOCAL_MODE`) keeps the workspace
 *      boundary
 *
 * Pre-fix (origin/main) 5, 6 and the full_autonomy half of 7 fail; 7's
 * strict/balanced half and 8 pass on both, which is what makes them regression
 * guards rather than restatements.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { PermissionEngine, type SecurityPreference } from '../permission-engine'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TMP_ROOT = realpathSync(tmpdir())
const HOME = homedir()
// The outside-root fixture cannot live under `/tmp`: `write_file` rewrites a
// `/tmp/...` write into the workspace's `.tmp/` (`scratchPathForWrite`, which this
// card deliberately leaves alone). On Linux — CI included — `tmpdir()` *is* `/tmp`
// and the isolated runner even puts `$HOME` under it, so either one is redirected
// inside the workspace. The package dir is never `/tmp`, and the directory is
// removed in `afterEach`.
const OUTSIDE_ROOT = process.cwd()

let TEST_DIR = ''
let OUTSIDE_DIR = ''
const savedEnv: Record<string, string | undefined> = {}

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key]
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
}

/** A desktop runtime: local mode on, and the folder-linked roots published. */
function desktopLinked(): void {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.LINKED_FOLDERS = JSON.stringify([TEST_DIR])
}

function makeCtx(preference: SecurityPreference, opts: { actionsOnly?: boolean } = {}): ToolContext {
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
    projectId: 'qa-sho209-part2',
    commandRegistry: new CommandRegistry(),
    permissionEngine: new PermissionEngine({
      workspaceDir: TEST_DIR,
      preference,
      actionsOnly: opts.actionsOnly,
    }),
  } as ToolContext
}

const FULL: SecurityPreference = { mode: 'full_autonomy', approvalTimeoutSeconds: 30 }

/**
 * The file tools answer a refusal either as `{ error }` or by throwing out of
 * `execute` (`assertWithinWorkspace` throws), so both are normalised here.
 */
async function tool(ctx: ToolContext, name: string, params: Record<string, any>): Promise<any> {
  const t = createTools(ctx).find((x) => x.name === name)
  if (!t) throw new Error(`tool missing: ${name}`)
  try {
    const result: any = await t.execute('qa-sho209-p2', params)
    return result.details
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const DENIED = /Permission denied|never allowed|managed by Shogo/

describe('SHO-209 part 2 — full_autonomy blocks no file paths', () => {
  beforeEach(() => {
    TEST_DIR = realpathSync(mkdtempSync(join(TMP_ROOT, 'qa-sho209p2-ws-')))
    OUTSIDE_DIR = realpathSync(mkdtempSync(join(OUTSIDE_ROOT, '.qa-sho209p2-out-')))
    trustWorkspaceForTests(TEST_DIR)
    saveEnv('SHOGO_LOCAL_MODE', 'LINKED_FOLDERS')
  })

  afterEach(() => {
    restoreEnv()
    rmSync(TEST_DIR, { recursive: true, force: true })
    rmSync(OUTSIDE_DIR, { recursive: true, force: true })
  })

  afterAll(() => clearTrustForTests())

  // ---- criterion 5 -------------------------------------------------------

  test('AC5: full_autonomy reads a credential-prefix path (probe that cannot exist)', async () => {
    desktopLinked()
    for (const probe of [join(HOME, '.ssh', 'sho-209-qa-probe'), join(HOME, '.aws', 'sho-209-qa-probe')]) {
      const result = await tool(makeCtx(FULL), 'read_file', { path: probe })
      expect(String(result.error ?? '')).not.toMatch(/Permission denied/)
      expect(String(result.error ?? '')).toMatch(/not found|no such file/i)
    }
  })

  test('AC5: full_autonomy writes inside a blocked prefix', async () => {
    desktopLinked()
    // `join(HOME, '.zshrc')` is a blocked *prefix*, so this probe file matches it
    // without ever going near the person's real shell rc. (`delete_file` is out of
    // scope: it only ever accepts paths under the workspace `files/` directory.)
    const probe = join(HOME, '.zshrc-sho-209-qa-probe')
    let onDisk = probe
    try {
      const written = await tool(makeCtx(FULL), 'write_file', { path: probe, content: 'qa\n' })
      expect(String(written.error ?? '')).not.toMatch(/Permission denied/)
      // The isolated runner puts HOME under /tmp, and `write_file` scratch-rewrites a
      // /tmp write into the workspace (`scratchPathForWrite`, which this card leaves
      // alone). The assertion that matters is that full_autonomy did not refuse it;
      // follow the remap the tool reports so the bytes are still checked.
      onDisk = written.remappedFrom ? resolve(TEST_DIR, written.path) : probe
      expect(readFileSync(onDisk, 'utf-8')).toBe('qa\n')

      const read = await tool(makeCtx(FULL), 'read_file', { path: onDisk })
      expect(String(read.error ?? '')).not.toMatch(/Permission denied/)
      expect(read.content).toBe('qa\n')
    } finally {
      rmSync(onDisk, { force: true })
      if (onDisk !== probe) rmSync(probe, { force: true })
    }
  })

  test('AC5: full_autonomy reads /etc/passwd; the system category is allowed', async () => {
    desktopLinked()
    const result = await tool(makeCtx(FULL), 'read_file', { path: '/etc/passwd' })
    expect(String(result.error ?? '')).not.toMatch(/Permission denied/)
    expect(String(result.content ?? '')).toContain('root')

    expect(makeCtx(FULL).permissionEngine!.check('system', 'sudo', {}).action).toBe('allow')
  })

  // ---- criterion 6 -------------------------------------------------------

  test('AC6: a folder-linked desktop project writes, reads and edits outside its roots', async () => {
    desktopLinked()
    const outside = join(OUTSIDE_DIR, 'note.txt')
    const ctx = makeCtx(FULL)

    const written = await tool(ctx, 'write_file', { path: outside, content: 'one\n' })
    expect(String(written.error ?? '')).not.toMatch(/outside|allowed folders|Permission denied/)
    expect(readFileSync(outside, 'utf-8')).toBe('one\n')

    const read = await tool(makeCtx(FULL), 'read_file', { path: outside })
    expect(read.content).toBe('one\n')

    const edited = await tool(makeCtx(FULL), 'edit_file', {
      path: outside,
      old_string: 'one',
      new_string: 'two',
    })
    expect(String(edited.error ?? '')).not.toMatch(/outside|allowed folders|Permission denied/)
    expect(readFileSync(outside, 'utf-8')).toBe('two\n')
  })

  // ---- criterion 7 -------------------------------------------------------

  test('AC7: balanced refuses the same outside path and the same credential path', async () => {
    desktopLinked()
    const outside = join(OUTSIDE_DIR, 'balanced.txt')
    writeFileSync(outside, 'x\n')

    const read = await tool(makeCtx({ mode: 'balanced', approvalTimeoutSeconds: 30 }), 'read_file', {
      path: outside,
    })
    expect(String(read.error ?? '')).toMatch(/allowed folders|outside/i)

    const ssh = await tool(makeCtx({ mode: 'balanced', approvalTimeoutSeconds: 30 }), 'read_file', {
      path: join(HOME, '.ssh', 'sho-209-qa-probe'),
    })
    expect(String(ssh.error ?? '')).toContain('Permission denied')
  })

  test('AC7: a configured fileAccess deny still refuses in full_autonomy', async () => {
    desktopLinked()
    const denied = await tool(
      makeCtx({
        mode: 'full_autonomy',
        approvalTimeoutSeconds: 30,
        overrides: { fileAccess: { deny: ['~/.ssh/*'] } },
      } as SecurityPreference),
      'read_file',
      { path: '~/.ssh/id_ed25519' },
    )
    expect(String(denied.error ?? '')).toContain('Permission denied')
  })

  test('AC7: a folder blocked in Settings still refuses in full_autonomy', async () => {
    desktopLinked()
    const blockedFile = join(OUTSIDE_DIR, 'blocked.txt')
    writeFileSync(blockedFile, 'x\n')
    const ctx = makeCtx({
      mode: 'full_autonomy',
      approvalTimeoutSeconds: 30,
      localAccess: { blockedFolders: [OUTSIDE_DIR] },
    } as SecurityPreference)

    const result = await tool(ctx, 'read_file', { path: blockedFile })
    expect(String(result.error ?? '')).toMatch(/blocked in Shogo settings/i)
  })

  test('AC7: a protected workspace file is still refused in full_autonomy', async () => {
    desktopLinked()
    const result = await tool(makeCtx(FULL), 'write_file', {
      path: join(TEST_DIR, 'src/main.tsx'),
      content: 'x\n',
    })
    expect(String(result.error ?? '')).toMatch(DENIED)
  })

  // ---- criterion 8 -------------------------------------------------------

  test('AC8: a cloud-pod-shaped runtime keeps the workspace boundary', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const outside = join(OUTSIDE_DIR, 'pod.txt')

    // The pod's engine is actionsOnly but its mode is still full_autonomy — the
    // only thing standing between it and an unrestricted path is the missing
    // SHOGO_LOCAL_MODE, so assert both linked and unlinked pod shapes.
    for (const linked of [true, false]) {
      if (linked) process.env.LINKED_FOLDERS = JSON.stringify([TEST_DIR])
      else delete process.env.LINKED_FOLDERS

      const written = await tool(makeCtx(FULL, { actionsOnly: true }), 'write_file', {
        path: outside,
        content: 'x\n',
      })
      expect(String(written.error ?? '')).toMatch(/outside|allowed folders/i)
      expect(existsSync(outside)).toBe(false)
    }
  })
})
