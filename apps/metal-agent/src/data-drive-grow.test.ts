// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * data-drive.grow — the host half of a live workspace-drive grow (SHO-349).
 *
 * Only `grow` is exercised: `provision` needs mkfs.ext4 on the host, but the
 * behaviour that matters here is the ftruncate-up-only contract — sparse,
 * never shrinks, `null` when already big enough so the caller can skip
 * `PATCH /drives`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DataDriveProvisioner } from './data-drive'

const MiB = 1024 * 1024

describe('DataDriveProvisioner.grow', () => {
  let dir: string
  let drive: string
  let provisioner: DataDriveProvisioner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drive-grow-'))
    drive = join(dir, 'vm1.ws.ext4')
    writeFileSync(drive, Buffer.alloc(4 * MiB, 7))
    provisioner = new DataDriveProvisioner({ runDir: dir } as any)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('grows the (sparse) file and reports from/to', () => {
    const grew = provisioner.grow(drive, 20)
    expect(grew).toEqual({ fromMiB: 4, toMiB: 20 })
    expect(statSync(drive).size).toBe(20 * MiB)
  })

  it('is a no-op (null) when the drive is already at least that big', () => {
    expect(provisioner.grow(drive, 4)).toBeNull()
    expect(provisioner.grow(drive, 1)).toBeNull()
    expect(statSync(drive).size).toBe(4 * MiB)
  })

  it('never shrinks', () => {
    provisioner.grow(drive, 10)
    expect(provisioner.grow(drive, 2)).toBeNull()
    expect(statSync(drive).size).toBe(10 * MiB)
  })

  it('leaves existing bytes intact', () => {
    provisioner.grow(drive, 8)
    const fd = openSync(drive, 'r')
    const head = Buffer.alloc(4 * MiB)
    try {
      readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
    expect(head.every((b) => b === 7)).toBe(true)
  })
})
