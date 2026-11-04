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
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
    engine.requestApproval(`remote-${tool}`, tool, remoteDeviceApprovalCategory(tool) as any, args, 'another runtime asked')
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
        return true
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
      requestApproval: async () => true,
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
        return true
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
