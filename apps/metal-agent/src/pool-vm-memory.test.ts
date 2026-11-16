// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-project guest memory: an assignment that asks for more memory than the
 * pool's VMs have (`SHOGO_VM_BOOT_MEM_MIB`) boots a dedicated VM of that size
 * instead of claiming a pooled one. Rendering video in a 4 GiB guest kernel
 * panicked three times in one evening and cost the project its workspace.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool, vmBootSize, vmMemMiBFromEnv, vmVcpusFromEnv } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakeMgr(guestPort: number, boots: FcVmConfig[]) {
  let n = 0
  return {
    async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
      boots.push(cfg)
      n++
      return {
        id: `vm-${n}`,
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        pid: 1000 + n,
        platform: 'linux',
        net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
        rootfs: `/tmp/fake-rootfs-${n}`,
        socketPath: `/tmp/fake-${n}.sock`,
        serialLog: `/tmp/fake-${n}.serial`,
        vcpus: cfg.cpus ?? 2,
        memoryMB: cfg.memoryMB ?? 4096,
        vmClass: cfg.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    adoptVM: () => {},
  }
}

function makePool(poolSize: number) {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  const dir = mkdtempSync(join(tmpdir(), 'pool-vm-memory-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  const baseRootfs = join(dir, 'rootfs.ext4')
  writeFileSync(baseRootfs, Buffer.alloc(1024))
  const cfg = { ...config, work: dir, snapDir, runDir, baseRootfs, poolSize, memMiB: 4096, vcpus: 2, snapStore: 'none' } as MetalConfig
  const boots: FcVmConfig[] = []
  const pool = new MetalWarmPool(fakeMgr(server.port!, boots) as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
  return { pool, boots }
}

describe('per-project VM memory', () => {
  test('parses, ignores junk, and caps the request', () => {
    expect(vmMemMiBFromEnv({ SHOGO_VM_BOOT_MEM_MIB: '8192' })).toBe(8192)
    expect(vmMemMiBFromEnv({})).toBeUndefined()
    expect(vmMemMiBFromEnv({ SHOGO_VM_BOOT_MEM_MIB: 'lots' })).toBeUndefined()
    expect(vmMemMiBFromEnv({ SHOGO_VM_BOOT_MEM_MIB: '999999' })).toBe(32 * 1024)
  })

  test('a request above the pool size boots a dedicated VM of that size', async () => {
    const { pool, boots } = makePool(0)
    await pool.start()
    const a = await pool.assign('ws:proj:p1', { SHOGO_VM_BOOT_MEM_MIB: '8192' })
    expect(a.handle.memoryMB).toBe(8192)
    expect(boots.at(-1)?.memoryMB).toBe(8192)
  })

  test('a request at or below the pool size is served from the pool', async () => {
    const { pool, boots } = makePool(0)
    await pool.start()
    const a = await pool.assign('ws:proj:p1', { SHOGO_VM_BOOT_MEM_MIB: '2048' })
    expect(a.handle.memoryMB).toBe(4096)
    expect(boots.at(-1)?.memoryMB).toBeUndefined()
  })

  test('parses, ignores junk, and caps a vCPU request', () => {
    expect(vmVcpusFromEnv({ SHOGO_VM_BOOT_VCPUS: '4' })).toBe(4)
    expect(vmVcpusFromEnv({})).toBeUndefined()
    expect(vmVcpusFromEnv({ SHOGO_VM_BOOT_VCPUS: 'many' })).toBeUndefined()
    expect(vmVcpusFromEnv({ SHOGO_VM_BOOT_VCPUS: '64' })).toBe(16)
  })

  test('4 vCPU / 8 GiB boots a dedicated VM of exactly that size', async () => {
    const { pool, boots } = makePool(0)
    await pool.start()
    const a = await pool.assign('ws:proj:p1', { SHOGO_VM_BOOT_MEM_MIB: '8192', SHOGO_VM_BOOT_VCPUS: '4' })
    expect(a.handle.memoryMB).toBe(8192)
    expect(a.handle.vcpus).toBe(4)
    expect(boots.at(-1)?.memoryMB).toBe(8192)
    expect(boots.at(-1)?.cpus).toBe(4)
  })

  test('more vCPUs alone also skips the pool, keeping the class memory', async () => {
    const { pool, boots } = makePool(0)
    await pool.start()
    const a = await pool.assign('ws:proj:p1', { SHOGO_VM_BOOT_VCPUS: '4' })
    expect(a.handle.vcpus).toBe(4)
    expect(boots.at(-1)?.memoryMB).toBeUndefined()
  })

  test('a vCPU request at or below the class count is served from the pool', async () => {
    const { pool, boots } = makePool(0)
    await pool.start()
    await pool.assign('ws:proj:p1', { SHOGO_VM_BOOT_VCPUS: '2' })
    expect(boots.at(-1)?.cpus).toBeUndefined()
  })

  test('vmBootSize: upgrade raises only what was asked; a downgrade (no request) is the pool size', () => {
    const cc = { vcpus: 2, memMiB: 4096 }
    expect(vmBootSize({ SHOGO_VM_BOOT_VCPUS: '4', SHOGO_VM_BOOT_MEM_MIB: '8192' }, cc)).toEqual({ cpus: 4, memoryMB: 8192 })
    expect(vmBootSize({ SHOGO_VM_BOOT_MEM_MIB: '8192' }, cc)).toEqual({ memoryMB: 8192 })
    expect(vmBootSize({ SHOGO_VM_BOOT_VCPUS: '2', SHOGO_VM_BOOT_MEM_MIB: '4096' }, cc)).toBeUndefined()
    expect(vmBootSize({}, cc)).toBeUndefined()
    expect(vmBootSize(undefined, cc)).toBeUndefined()
  })
})
