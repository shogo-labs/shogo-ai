// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for DataDriveProvisioner — the docker-class second data drive
 * (Phase 1 of the Tier 2 docker project class plan). `mkfs.ext4` isn't
 * available in CI/dev, so we override the protected `runMkfs` seam and assert
 * only the file lifecycle this class owns (sparse allocation, existence,
 * release) — the same "overridable seam" pattern FirecrackerVMManager already
 * uses for host-only tools (tap/dm commands).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { DataDriveProvisioner } from './data-drive'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

class FakeDataDriveProvisioner extends DataDriveProvisioner {
  mkfsCalls: string[] = []
  protected override runMkfs(path: string): void {
    this.mkfsCalls.push(path)
  }
}

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'datadrive-'))
  dirs.push(dir)
  return { ...config, runDir: dir }
}

describe('DataDriveProvisioner', () => {
  test('provision creates a sparse file of the requested logical size and formats it', () => {
    const cfg = makeCfg()
    const dd = new FakeDataDriveProvisioner(cfg as any)
    const path = dd.provision('fcvm-1', 1024)

    expect(path).toBe(join(cfg.runDir, 'fcvm-1.data.ext4'))
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBe(1024 * 1024 * 1024)
    expect(dd.sizeMiB(path)).toBe(1024)
    expect(dd.mkfsCalls).toEqual([path])
  })

  test('exists reflects the current filesystem state', () => {
    const cfg = makeCfg()
    const dd = new FakeDataDriveProvisioner(cfg as any)
    const path = dd.provision('fcvm-2', 64)
    expect(dd.exists(path)).toBe(true)
    dd.release(path)
    expect(dd.exists(path)).toBe(false)
  })

  test('release is idempotent (no throw on an already-missing file)', () => {
    const cfg = makeCfg()
    const dd = new FakeDataDriveProvisioner(cfg as any)
    const path = join(cfg.runDir, 'never-existed.data.ext4')
    expect(() => dd.release(path)).not.toThrow()
  })

  test('two VMs get independent, differently-named data drives', () => {
    const cfg = makeCfg()
    const dd = new FakeDataDriveProvisioner(cfg as any)
    const a = dd.provision('fcvm-a', 32)
    const b = dd.provision('fcvm-b', 32)
    expect(a).not.toBe(b)
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
  })

  test('sizeMiB returns 0 for a missing file rather than throwing', () => {
    const cfg = makeCfg()
    const dd = new FakeDataDriveProvisioner(cfg as any)
    expect(dd.sizeMiB(join(cfg.runDir, 'missing.data.ext4'))).toBe(0)
  })
})
