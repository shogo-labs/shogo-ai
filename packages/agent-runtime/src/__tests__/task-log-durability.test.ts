// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The log has to outlive the VM (SHO-141, #1634).
 *
 * `onAssign` puts `<workspace>/.shogo` on the VM's tmp overlay so SQLite works.
 * Everything else in there — including `tasks/` — used to die with the VM, so a
 * task killed by a restart reported an Output path that no longer existed. These
 * tests pin the cure: `tasks/` is a symlink onto host-backed storage, the same
 * logical path every caller uses, and a second assign on the same project still
 * sees the first VM's log.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { durableTaskLogRoot, ensureDurableTaskLogs } from '../task-log-durability'
import { taskOutputDir } from '../task-output'

function hostRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sho-host-'))
}

/** A stand-in for `POOL_STATE_ROOT/<projectId>/.shogo` on one VM's overlay. */
function vmShogoDir(label: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `sho-${label}-`)), '.shogo')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The `<workspace>` a mounted VM sees: a symlink onto the host project dir. */
function mountedWorkspace(root: string, projectId: string): string {
  const project = join(root, projectId)
  mkdirSync(project, { recursive: true })
  return project
}

describe('a task log survives the VM that wrote it', () => {
  test('a second assign on the same project still sees the first VM log', () => {
    const root = hostRoot()
    const projectId = 'proj-abc'
    const workspace = mountedWorkspace(root, projectId)

    // VM 1: assign, then a background task writes its log through the logical path.
    const vm1 = vmShogoDir('vm1')
    ensureDurableTaskLogs({ localShogoDir: vm1, hostWorkspacesRoot: root, projectId })
    const logDir = join(vm1, 'tasks', 'session-1')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 't_abc123.log')
    writeFileSync(logPath, '---\nstatus: interrupted\n---\nthe work that did not finish\n')

    // VM 2: a replacement VM, empty overlay, same project and host storage.
    const vm2 = vmShogoDir('vm2')
    ensureDurableTaskLogs({ localShogoDir: vm2, hostWorkspacesRoot: root, projectId })

    const throughVm2 = join(vm2, 'tasks', 'session-1', 't_abc123.log')
    expect(existsSync(throughVm2)).toBe(true)
    expect(readFileSync(throughVm2, 'utf-8')).toContain('the work that did not finish')

    // And through the path every caller builds: <workspace>/.shogo/tasks/<session>.
    const symlinked = join(workspace, '.shogo')
    mkdirSync(workspace, { recursive: true })
    try { require('fs').symlinkSync(vm2, symlinked) } catch { /* already linked */ }
    expect(readFileSync(join(taskOutputDir(workspace, 'session-1'), 't_abc123.log'), 'utf-8'))
      .toContain('the work that did not finish')
  })

  test('a runtime restart on the same VM keeps the file where it was', () => {
    const root = hostRoot()
    const projectId = 'proj-restart'
    const vm = vmShogoDir('vm-restart')

    const first = ensureDurableTaskLogs({ localShogoDir: vm, hostWorkspacesRoot: root, projectId })
    expect(first.linked).toBe(true)
    const logPath = join(vm, 'tasks', 's', 't_keep.log')
    mkdirSync(join(vm, 'tasks', 's'), { recursive: true })
    writeFileSync(logPath, 'kept\n')

    // A process restart re-runs assignment in the same VM: same overlay dir.
    const second = ensureDurableTaskLogs({ localShogoDir: vm, hostWorkspacesRoot: root, projectId })
    expect(second.linked).toBe(true)
    expect(second.durableRoot).toBe(first.durableRoot)
    expect(readFileSync(logPath, 'utf-8')).toBe('kept\n')
    expect(readlinkSync(join(vm, 'tasks'))).toBe(durableTaskLogRoot(root, projectId))
  })

  test('a pre-mount .shogo that was moved aside is carried across', () => {
    const root = hostRoot()
    const projectId = 'proj-aside'
    const vm = vmShogoDir('vm-aside')

    // HOST-mode leftovers: a real `.shogo/tasks` under the workspace.
    const aside = join(mkdtempSync(join(tmpdir(), 'sho-aside-')), '.shogo.host-bak-1')
    mkdirSync(join(aside, 'tasks', 'session-old'), { recursive: true })
    writeFileSync(join(aside, 'tasks', 'session-old', 't_old.log'), 'older than the mount\n')

    ensureDurableTaskLogs({ localShogoDir: vm, hostWorkspacesRoot: root, projectId, adoptFrom: [aside] })

    expect(readFileSync(join(vm, 'tasks', 'session-old', 't_old.log'), 'utf-8'))
      .toBe('older than the mount\n')
    // Carried across, not duplicated: the backup keeps its other `.shogo` state
    // but the log lives in one place, so a later restore cannot resurrect it.
    expect(existsSync(join(aside, 'tasks', 'session-old', 't_old.log'))).toBe(false)
    expect(existsSync(aside)).toBe(true)
  })

  test('a real tasks dir already on the overlay is adopted, not discarded', () => {
    const root = hostRoot()
    const projectId = 'proj-overlay'
    const vm = vmShogoDir('vm-overlay')
    mkdirSync(join(vm, 'tasks', 'session-x'), { recursive: true })
    writeFileSync(join(vm, 'tasks', 'session-x', 't_overlay.log'), 'written before the link\n')

    ensureDurableTaskLogs({ localShogoDir: vm, hostWorkspacesRoot: root, projectId })

    expect(readlinkSync(join(vm, 'tasks'))).toBe(durableTaskLogRoot(root, projectId))
    expect(readFileSync(join(vm, 'tasks', 'session-x', 't_overlay.log'), 'utf-8'))
      .toBe('written before the link\n')
  })

  test('without a mount nothing is redirected', () => {
    const vm = vmShogoDir('vm-desktop')
    const result = ensureDurableTaskLogs({ localShogoDir: vm, projectId: 'proj-desktop' })

    expect(result).toEqual({ durableRoot: null, linked: false })
    expect(existsSync(join(vm, 'tasks'))).toBe(false)
  })

  test('an unusable host dir warns and leaves the assign alive', () => {
    const blockers = mkdtempSync(join(tmpdir(), 'sho-blocked-'))
    const blocker = join(blockers, 'not-a-dir')
    writeFileSync(blocker, 'x')

    const vm = vmShogoDir('vm-blocked')
    const warnings: string[] = []
    const result = ensureDurableTaskLogs({
      localShogoDir: vm,
      hostWorkspacesRoot: join(blocker, 'host'),
      projectId: 'proj-blocked',
      warn: (message) => warnings.push(message),
    })

    // A throwing assign is a warm-pool boot failure; degrade instead.
    expect(result.linked).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('will not survive a restart')
  })
})
