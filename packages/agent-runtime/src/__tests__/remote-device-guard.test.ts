// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A tool call another of the person's runtimes asks this computer to run
 * (SHO-329): nothing runs until the person turns the switch on, and a command
 * or a file change is approved at this computer even when its own agent runs in
 * full autonomy.
 *
 *   bun test packages/agent-runtime/src/__tests__/remote-device-guard.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@shogo/shared-runtime', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { PermissionEngine } = await import('../permission-engine')
const { guardRemoteDeviceCall, remoteDeviceApprovalCategory } = await import('../remote-device-guard')
const { normalizeLocalAccessPrefs, toLocalAccessPolicy } = await import('../local-access')

let workspaceDir: string
beforeEach(() => {
  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-remote-device-')))
})
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

/** A real engine in full autonomy, with the UI's answers fed back by hand. */
function fullAutonomyEngine(answers: boolean[] = []) {
  const asked: Array<{ toolName: string; category: string; params: Record<string, unknown> }> = []
  const engine = new PermissionEngine({
    preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
    workspaceDir,
  })
  engine.setSseCallback((event) => {
    if (event?.type !== 'data-permission-request') return
    asked.push({
      toolName: event.data.toolName,
      category: event.data.category,
      params: event.data.params,
    })
    // Answer on the next tick, the way the desktop window does.
    setTimeout(() => engine.handleApprovalResponse({ id: event.data.id, decision: (answers.shift() ?? true) ? 'allow_once' : 'deny' } as any), 0)
  })
  return { engine, asked }
}

function requestApprovalWith(engine: InstanceType<typeof PermissionEngine>) {
  return (tool: string, args: Record<string, unknown>) =>
    engine.requestRemoteDeviceApproval(tool, remoteDeviceApprovalCategory(tool) as any, args, 'another runtime asked')
}

describe('remote device tools opt-in', () => {
  test('nothing runs while the switch is off — not even a read', async () => {
    let asked = false
    const refused = await guardRemoteDeviceCall({
      tool: 'read_file',
      args: { path: 'notes.md' },
      policy: { remoteTools: false },
      requestApproval: async () => {
        asked = true
        return 'approved' as const
      },
    })
    expect(refused).toMatchObject({ ok: false, status: 403, code: 'remote_device_tools_disabled' })
    expect(asked).toBe(false)
    expect(refused.ok === false && refused.message).toContain('Settings > Computer and files')
  })

  test('a policy that was never configured is off, not on', async () => {
    const refused = await guardRemoteDeviceCall({
      tool: 'read_file',
      args: { path: 'notes.md' },
      policy: undefined,
      requestApproval: async () => 'approved' as const,
    })
    expect(refused).toMatchObject({ ok: false, code: 'remote_device_tools_disabled' })
  })

  test('the saved preference keeps the switch and hands it to the runtime', () => {
    const on = normalizeLocalAccessPrefs({ remoteTools: true })
    expect(on.remoteTools).toBe(true)
    expect(toLocalAccessPolicy(on).remoteTools).toBe(true)
    // Never configured, or garbage: off.
    expect(normalizeLocalAccessPrefs({}).remoteTools).toBe(false)
    expect(toLocalAccessPolicy(normalizeLocalAccessPrefs({ remoteTools: 'yes' })).remoteTools).toBe(false)
  })

  test('with the switch on, a read runs without asking', async () => {
    let asked = false
    const allowed = await guardRemoteDeviceCall({
      tool: 'read_file',
      args: { path: 'notes.md' },
      policy: { remoteTools: true },
      requestApproval: async () => {
        asked = true
        return 'approved' as const
      },
    })
    expect(allowed).toEqual({ ok: true })
    expect(asked).toBe(false)
  })

  test('with the switch on, exec is approved at this computer even in full autonomy', async () => {
    const { engine, asked } = fullAutonomyEngine([true])
    engine.setLocalAccess({ remoteTools: true })

    // The engine's own answer for this computer's own agent is "allow".
    expect(engine.check('shell', 'exec', { command: 'ls' })).toMatchObject({ action: 'allow' })

    const result = await guardRemoteDeviceCall({
      tool: 'exec',
      args: { command: 'rm -rf ~/Documents' },
      policy: engine.getLocalAccess(),
      requestApproval: requestApprovalWith(engine),
    })
    expect(result).toEqual({ ok: true })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.toolName).toBe('exec')
    expect(asked[0]!.category).toBe('shell')
  })

  test('a refusal at this computer is a 403 the caller can explain', async () => {
    const { engine, asked } = fullAutonomyEngine([false])
    engine.setLocalAccess({ remoteTools: true })
    const result = await guardRemoteDeviceCall({
      tool: 'write_file',
      args: { path: 'notes.md', content: 'hi' },
      policy: engine.getLocalAccess(),
      requestApproval: requestApprovalWith(engine),
    })
    expect(result).toMatchObject({ ok: false, status: 403, code: 'remote_device_tool_denied' })
    expect(result.ok === false && result.message).toContain('write_file')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.category).toBe('file_write')
  })

  test('every write tool and the shell are the ones that ask; reads do not', () => {
    expect(remoteDeviceApprovalCategory('delete_file')).toBe('file_delete')
    expect(remoteDeviceApprovalCategory('edit_file')).toBe('file_write')
    expect(remoteDeviceApprovalCategory('exec_wait')).toBe('shell')
  })
})

describe('a remote call is never answered from the local approval cache (SHO-333)', () => {
  test('approving `exec X` on this computer does not approve a remote `exec X`', async () => {
    const { engine, asked } = fullAutonomyEngine([true, true])
    engine.setLocalAccess({ remoteTools: true })
    const command = { command: 'rm -rf build' }

    // This computer's own agent asks once and is allowed; the engine caches it.
    expect(await engine.requestApproval('local-1', 'exec', 'shell', command, 'own turn')).toBe(true)
    expect(asked).toHaveLength(1)

    const result = await guardRemoteDeviceCall({
      tool: 'exec',
      args: command,
      policy: engine.getLocalAccess(),
      requestApproval: requestApprovalWith(engine),
    })

    expect(result).toEqual({ ok: true })
    // The same tool and the same params, and the person is asked again.
    expect(asked).toHaveLength(2)
  })

  test('approving a remote `exec X` does not approve this computer\'s own `exec X`', async () => {
    const { engine, asked } = fullAutonomyEngine([true, true])
    engine.setLocalAccess({ remoteTools: true })
    const command = { command: 'git push' }

    expect(await guardRemoteDeviceCall({
      tool: 'exec',
      args: command,
      policy: engine.getLocalAccess(),
      requestApproval: requestApprovalWith(engine),
    })).toEqual({ ok: true })
    expect(asked).toHaveLength(1)

    expect(await engine.requestApproval('local-1', 'exec', 'shell', command, 'own turn')).toBe(true)
    expect(asked).toHaveLength(2)
  })

  test('a saved \"always allow\" rule for this computer does not approve a remote call either', async () => {
    // The saved rules outlive the engine, so this is the one an owner gave a
    // previous session. A remote command matching it still asks (SHO-333).
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(
      join(workspaceDir, '.shogo', 'permissions.json'),
      JSON.stringify({ shellCommands: { allow: ['rm -rf *'] } }),
      'utf-8',
    )
    const { engine, asked } = fullAutonomyEngine([true])
    engine.setLocalAccess({ remoteTools: true })

    const result = await guardRemoteDeviceCall({
      tool: 'exec',
      args: { command: 'rm -rf build' },
      policy: engine.getLocalAccess(),
      requestApproval: requestApprovalWith(engine),
    })

    expect(result).toEqual({ ok: true })
    expect(asked.map((a) => a.params.command)).toEqual(['rm -rf build'])
  })

  test('a remote "always allow" answer is not written to the saved rules', async () => {
    const stored: string[] = []
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    engine.setSseCallback((event) => {
      if (event?.type !== 'data-permission-request') return
      setTimeout(
        () => engine.handleApprovalResponse({ id: event.data.id, decision: 'always_allow', pattern: 'rm -rf *' } as any),
        0,
      )
    })

    expect(await engine.requestRemoteDeviceApproval('exec', 'shell', { command: 'rm -rf build' }, 'remote')).toBe('approved')
    stored.push(...(engine.getOverrides()?.shellCommands?.allow ?? []))
    expect(stored).not.toContain('rm -rf *')
  })
})

describe('no window stream: the request waits instead of being refused (SHO-333)', () => {
  test('a remote request queues, then reaches the window that opens next', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    const asked: string[] = []

    const pending = engine.requestRemoteDeviceApproval('exec', 'shell', { command: 'ls' }, 'another runtime asked')
    // Nothing is in front of anyone yet, so the caller is still waiting.
    expect(engine.listQueuedApprovals().map((r) => r.toolName)).toEqual(['exec'])

    engine.setSseCallback((event) => {
      if (event?.type !== 'data-permission-request') return
      asked.push(event.data.toolName)
      setTimeout(() => engine.handleApprovalResponse({ id: event.data.id, decision: 'allow_once' } as any), 0)
    })

    expect(await pending).toBe('approved')
    expect(asked).toEqual(['exec'])
    expect(engine.listQueuedApprovals()).toHaveLength(0)
  })

  test('a turn starting in another window does not drop a queued request', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    const pending = engine.requestRemoteDeviceApproval('exec', 'shell', { command: 'ls' }, 'another runtime asked', 5)
    expect(engine.listQueuedApprovals()).toHaveLength(1)

    // Every turn resets the engine's per-turn state; the queued remote request
    // belongs to nobody's turn and must survive it.
    engine.resetTurn()
    expect(engine.listQueuedApprovals()).toHaveLength(1)

    const asked: string[] = []
    engine.setSseCallback((event) => {
      if (event?.type !== 'data-permission-request') return
      asked.push(event.data.toolName)
      setTimeout(() => engine.handleApprovalResponse({ id: event.data.id, decision: 'allow_once' } as any), 0)
    })

    expect(await pending).toBe('approved')
    expect(asked).toEqual(['exec'])
  })

  test('a request nobody answers answers `remote_approval_timeout`', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    engine.setLocalAccess({ remoteTools: true })

    const result = await guardRemoteDeviceCall({
      tool: 'exec',
      args: { command: 'ls' },
      policy: engine.getLocalAccess(),
      requestApproval: (tool, args) =>
        engine.requestRemoteDeviceApproval(tool, remoteDeviceApprovalCategory(tool) as any, args, 'another runtime asked', 0.05),
    })

    expect(result).toMatchObject({ ok: false, status: 403, code: 'remote_approval_timeout' })
    expect(result.ok === false && result.message).toContain('timed out')
  })

  test('a window that opens without approval leaves a clear unavailable answer', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    engine.setLocalAccess({ remoteTools: true })
    const pending = engine.requestRemoteDeviceApproval('write_file', 'file_write', { path: 'a.txt' }, 'remote')
    engine.setSseCallback(() => {
      throw new Error('stream closed')
    })

    expect(await pending).toBe('unavailable')
    expect(await guardRemoteDeviceCall({
      tool: 'write_file',
      args: { path: 'a.txt' },
      policy: engine.getLocalAccess(),
      requestApproval: () => pending,
    })).toMatchObject({ ok: false, status: 403, code: 'remote_approval_unavailable' })
  })

  test('this computer\'s own agent still fails closed with no window', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'balanced', approvalTimeoutSeconds: 5 },
      workspaceDir,
    })
    expect(await engine.requestApproval('local-1', 'exec', 'shell', { command: 'ls' }, 'own turn')).toBe(false)
    expect(engine.listQueuedApprovals()).toHaveLength(0)
  })
})
