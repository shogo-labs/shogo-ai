// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for VM-class resolution (Phase 1 of the Tier 2 docker project
 * class plan): `isVmClassSupported` and `classConfig`.
 */

import { describe, expect, test } from 'bun:test'
import { assertHostId, classConfig, config, isVmClassSupported, readHostId, VM_CLASSES, type MetalConfig } from './config'

function fakeCfg(overrides: Partial<MetalConfig> = {}): MetalConfig {
  return { ...config, ...overrides } as MetalConfig
}

describe('isVmClassSupported', () => {
  test('standard is always supported', () => {
    expect(isVmClassSupported(fakeCfg(), 'standard')).toBe(true)
    expect(
      isVmClassSupported(
        fakeCfg({ dockerClass: { ...config.dockerClass, baseRootfs: '' } }),
        'standard',
      ),
    ).toBe(true)
  })

  test('docker is unsupported with no rootfs configured (the default)', () => {
    const cfg = fakeCfg({ dockerClass: { ...config.dockerClass, baseRootfs: '' } })
    expect(isVmClassSupported(cfg, 'docker')).toBe(false)
  })

  test('docker is supported once a docker rootfs is configured', () => {
    const cfg = fakeCfg({
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/fc-spike/img/docker-rootfs.ext4' },
    })
    expect(isVmClassSupported(cfg, 'docker')).toBe(true)
  })

  test('docker is supported under dm when its own rootfs is configured', () => {
    const cfg = fakeCfg({
      rootfsCow: 'dm',
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/fc-spike/img/docker-rootfs.ext4' },
    })
    expect(isVmClassSupported(cfg, 'docker')).toBe(true)
    expect(isVmClassSupported(cfg, 'standard')).toBe(true)
  })
})

describe('classConfig', () => {
  test('standard reflects the top-level config fields exactly', () => {
    const cfg = fakeCfg({ kernel: '/k', baseRootfs: '/r', vcpus: 4, memMiB: 2048, poolSize: 3 })
    expect(classConfig(cfg, 'standard')).toEqual({
      vmClass: 'standard',
      kernel: '/k',
      baseRootfs: '/r',
      vcpus: 4,
      memMiB: 2048,
      poolSize: 3,
      dataDriveMiB: 0,
    })
  })

  test('docker uses its own overrides when configured', () => {
    const cfg = fakeCfg({
      kernel: '/standard-kernel',
      baseRootfs: '/standard-rootfs',
      dockerClass: {
        vmClass: 'docker',
        kernel: '/standard-kernel', // Phase 0: same kernel, no override needed
        baseRootfs: '/docker-rootfs',
        vcpus: 4,
        memMiB: 4096,
        poolSize: 2,
        dataDriveMiB: 20480,
      },
    })
    expect(classConfig(cfg, 'docker')).toEqual({
      vmClass: 'docker',
      kernel: '/standard-kernel',
      baseRootfs: '/docker-rootfs',
      vcpus: 4,
      memMiB: 4096,
      poolSize: 2,
      dataDriveMiB: 20480,
    })
  })

  test('docker with an unset rootfs falls back to the standard image (never a dangling path)', () => {
    const cfg = fakeCfg({
      baseRootfs: '/standard-rootfs',
      kernel: '/standard-kernel',
      dockerClass: { ...config.dockerClass, baseRootfs: '', kernel: '' },
    })
    const cc = classConfig(cfg, 'docker')
    expect(cc.baseRootfs).toBe('/standard-rootfs')
    expect(cc.kernel).toBe('/standard-kernel')
  })

  test('VM_CLASSES lists exactly standard + docker', () => {
    expect(VM_CLASSES).toEqual(['standard', 'docker'])
  })
})

describe('idle reclaim + free page reporting defaults (SHO-534)', () => {
  // Both features change the host's memory behaviour, so shipping them on by
  // default would apply them to prod without the staging numbers that authorise
  // it. A host that exports neither variable must read exactly as today does.
  test.skipIf(!!process.env.METAL_IDLE_RECLAIM || !!process.env.METAL_BALLOON_FREE_PAGE_REPORTING)(
    'both are off unless the host turns them on',
    () => {
      expect(config.idleReclaim).toBe(false)
      expect(config.balloonFreePageReporting).toBe(false)
    },
  )

  test('the idle floor defaults to the snapshot floor (one headroom number)', () => {
    expect(config.idleReclaimFloorMiB).toBe(config.balloonFloorMiB)
  })

  test('the idle window is short enough to fire before the idle-suspend window', () => {
    // bootstrapped hosts run METAL_IDLE_SUSPEND_MS=900000 (15m); reclaim is 5m
    expect(config.idleReclaimMs).toBe(300_000)
  })
})

describe('METAL_HOST_ID is required (no hostname fallback)', () => {
  // The fallback was `os.hostname`: two agents that both fell back registered
  // under one id, `registerHost` kept whichever heartbeat arrived last, and the
  // control plane showed one host where there were two — a live host's
  // load/disk/capacity overwritten every 30s by another machine's numbers.
  test('readHostId never substitutes the hostname', () => {
    expect(readHostId({ HOSTNAME: 'ip-10-0-0-7' })).toBe('')
    expect(readHostId({ HOSTNAME: 'ip-10-0-0-7', METAL_HOST_ID: '  ' })).toBe('')
    expect(readHostId({ METAL_HOST_ID: 'latitude-dal-1' })).toBe('latitude-dal-1')
  })

  test('assertHostId refuses to boot without one, naming the variable', () => {
    expect(() => assertHostId({ hostId: '' })).toThrow(/METAL_HOST_ID/)
    expect(() => assertHostId({ hostId: '' })).toThrow(/cloud-init/i)
    expect(() => assertHostId({ hostId: 'latitude-dal-1' })).not.toThrow()
  })
})
