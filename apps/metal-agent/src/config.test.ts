// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for VM-class resolution (Phase 1 of the Tier 2 docker project
 * class plan): `isVmClassSupported` and `classConfig`.
 */

import { describe, expect, test } from 'bun:test'
import { classConfig, config, isVmClassSupported, VM_CLASSES, type MetalConfig } from './config'

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

  test('docker is refused under dm rootfsCow even with a configured rootfs — fail-safe', () => {
    const cfg = fakeCfg({
      rootfsCow: 'dm',
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/fc-spike/img/docker-rootfs.ext4' },
    })
    expect(isVmClassSupported(cfg, 'docker')).toBe(false)
    // Standard is unaffected by dm mode.
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
