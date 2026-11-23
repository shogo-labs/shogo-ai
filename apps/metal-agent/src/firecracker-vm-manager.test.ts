// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { config } from './config'
import { FirecrackerVMManager } from './firecracker-vm-manager'

const root = mkdtempSync(join(tmpdir(), 'fcvm-socket-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A manager whose dirs are throwaway, so nothing touches /opt/fc-spike. */
function manager(runDir: string) {
  mkdirSync(runDir, { recursive: true })
  return new FirecrackerVMManager({ ...config, runDir, snapDir: join(root, 'snap') }) as any
}

describe('waitForSocket', () => {
  test('accepts a socket that is present even when the deadline has already passed', async () => {
    const runDir = join(root, 'present')
    const sock = join(runDir, 'fcvm-1-test.sock')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(sock, '')

    // timeout 0 makes the poll loop never turn, which is exactly what a starved
    // event loop looks like after a synchronous provision: the boot worked, we
    // only got to look after the deadline. That must not be a failed boot.
    await expect(manager(runDir).waitForSocket(sock, 0)).resolves.toBeUndefined()
  })

  test('still throws when firecracker never bound its socket', async () => {
    const runDir = join(root, 'absent')
    const sock = join(runDir, 'fcvm-2-test.sock')
    mkdirSync(runDir, { recursive: true })

    await expect(manager(runDir).waitForSocket(sock, 20)).rejects.toThrow(/never appeared/)
  })
})
