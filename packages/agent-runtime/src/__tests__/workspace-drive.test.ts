// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Guest half of a live workspace-drive grow (SHO-349).
 *
 * The commands are injected, so this covers the contract the HOST depends on:
 * the exact fsfreeze/resize2fs sequence, the "no drive" answer that must not
 * throw, and — most importantly — the watchdog that thaws /data even when the
 * host never comes back.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  handleWorkspaceDriveOp,
  resetWorkspaceDriveState,
  thawWorkspaceDrive,
} from '../workspace-drive'

const usage = { usedBytes: 5 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 }

type Call = { cmd: string; args: string[] }

function deps(calls: Call[], opts: { blkidCode?: number; freezeCode?: number; resizeCode?: number } = {}) {
  return {
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      if (cmd === 'blkid') {
        return { code: opts.blkidCode ?? 0, stdout: '/dev/vdb\n', stderr: '' }
      }
      if (cmd === 'fsfreeze') {
        return { code: opts.freezeCode ?? 0, stdout: '', stderr: opts.freezeCode ? 'freeze failed' : '' }
      }
      if (cmd === 'resize2fs') {
        return { code: opts.resizeCode ?? 0, stdout: '', stderr: opts.resizeCode ? 'resize failed' : '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    },
    usage: async () => usage,
    dir: '/data',
  }
}

describe('POST /pool/workspace-drive', () => {
  afterEach(() => {
    resetWorkspaceDriveState()
  })

  it('freezes /data and arms a watchdog', async () => {
    const calls: Call[] = []
    const res = await handleWorkspaceDriveOp('freeze', deps(calls))
    expect(res.status).toBe(200)
    expect(res.body.frozen).toBe(true)
    expect(calls).toContainEqual({ cmd: 'fsfreeze', args: ['-f', '/data'] })
    await thawWorkspaceDrive(deps(calls))
  })

  it('thaws /data', async () => {
    const calls: Call[] = []
    await handleWorkspaceDriveOp('freeze', deps(calls))
    const res = await handleWorkspaceDriveOp('thaw', deps(calls))
    expect(res.status).toBe(200)
    expect(res.body.frozen).toBe(false)
    expect(calls).toContainEqual({ cmd: 'fsfreeze', args: ['-u', '/data'] })
  })

  it('thaws itself when the host never comes back (watchdog)', async () => {
    const calls: Call[] = []
    await handleWorkspaceDriveOp('freeze', { ...deps(calls), freezeTimeoutMs: 20 })
    // The host "dies" here: no thaw is sent.
    await new Promise((r) => setTimeout(r, 80))
    expect(calls.some((c) => c.cmd === 'fsfreeze' && c.args[0] === '-u')).toBe(true)
  })

  it('resizes the filesystem on the labelled device', async () => {
    const calls: Call[] = []
    const res = await handleWorkspaceDriveOp('resize', deps(calls))
    expect(res.status).toBe(200)
    expect(calls).toContainEqual({ cmd: 'blkid', args: ['-L', 'shogo-ws'] })
    expect(calls).toContainEqual({ cmd: 'resize2fs', args: ['/dev/vdb'] })
    expect(res.body.totalBytes).toBe(usage.totalBytes)
  })

  it('answers 409 (not an error) when the guest has no workspace drive', async () => {
    const calls: Call[] = []
    const res = await handleWorkspaceDriveOp('resize', deps(calls, { blkidCode: 2 }))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_workspace_drive')
  })

  it('reports a failed freeze instead of pretending it is frozen', async () => {
    const calls: Call[] = []
    const res = await handleWorkspaceDriveOp('freeze', deps(calls, { freezeCode: 1 }))
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('freeze_failed')
  })

  it('rejects an unknown op', async () => {
    const res = await handleWorkspaceDriveOp('explode' as any, deps([]))
    expect(res.status).toBe(400)
  })
})
