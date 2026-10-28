// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203: `host-limits.json` is what makes a Settings change land on a running
 * app. It has to be written atomically (a watcher must never read half a
 * document and decide "no limit") and describe itself well enough for the OOM
 * note to name the setting and the machine.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildHostLimits,
  HOST_LIMITS_FILE_NAME,
  hostLimitsPath,
  hostRuntimeView,
  writeHostLimits,
} from '../host-limits'

const GB = 1024
const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-limits-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('buildHostLimits', () => {
  test('resolves the auto budget from this machine and marks it auto', () => {
    expect(buildHostLimits('auto', 128 * GB)).toEqual({
      execMemoryMB: 120 * GB,
      totalMemMB: 128 * GB,
      source: 'auto',
    })
    expect(buildHostLimits(undefined, 32 * GB).source).toBe('auto')
  })

  test('keeps an explicit value and marks it as a setting', () => {
    expect(buildHostLimits(24 * GB, 128 * GB)).toEqual({
      execMemoryMB: 24 * GB,
      totalMemMB: 128 * GB,
      source: 'settings',
    })
  })

  test('clamps an explicit value above the machine to its RAM', () => {
    expect(buildHostLimits(512 * GB, 64 * GB).execMemoryMB).toBe(64 * GB)
  })
})

describe('writeHostLimits', () => {
  test('writes the file the runtime watches, with no temp files left behind', () => {
    const dir = tempDir()
    const file = writeHostLimits(dir, buildHostLimits(32 * GB, 128 * GB))
    expect(file).toBe(hostLimitsPath(dir))
    expect(file.endsWith(HOST_LIMITS_FILE_NAME)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      execMemoryMB: 32 * GB,
      totalMemMB: 128 * GB,
      source: 'settings',
    })
    expect(readdirSync(dir)).toEqual([HOST_LIMITS_FILE_NAME])
  })

  test('overwrites in place, so a watcher sees one new value', () => {
    const dir = tempDir()
    writeHostLimits(dir, buildHostLimits('auto', 128 * GB))
    writeHostLimits(dir, buildHostLimits(8 * GB, 128 * GB))
    expect(JSON.parse(readFileSync(hostLimitsPath(dir), 'utf-8')).execMemoryMB).toBe(8 * GB)
    expect(readdirSync(dir)).toEqual([HOST_LIMITS_FILE_NAME])
  })
})

describe('hostRuntimeView', () => {
  test('reports the resolved budget and the machine size for Settings', () => {
    const view = hostRuntimeView({ memoryMB: 8192, cpuPercent: 0, execMemoryMB: 'auto' }, 128 * GB)
    expect(view).toEqual({
      memoryMB: 8192,
      cpuPercent: 0,
      execMemoryMB: 'auto',
      resolvedExecMemoryMB: 120 * GB,
      totalMemMB: 128 * GB,
    })
  })

  test('reports an explicit budget as set, resolved against this machine', () => {
    const view = hostRuntimeView({ memoryMB: 8192, cpuPercent: 0, execMemoryMB: 24 * GB }, 128 * GB)
    expect(view.execMemoryMB).toBe(24 * GB)
    expect(view.resolvedExecMemoryMB).toBe(24 * GB)
  })
})
