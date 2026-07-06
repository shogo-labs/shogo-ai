// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CacheIndex, type CacheEntry } from './cache-index'

const net = {
  tap: 'fctap0',
  hostIp: '172.16.0.1',
  guestIp: '172.16.0.2',
  netmask: '255.255.255.252',
  guestMac: '06:00:AC:10:00:02',
  bootIpArg: 'ip=...',
}

function entry(projectId: string, over: Partial<CacheEntry> = {}): CacheEntry {
  return {
    projectId,
    vmId: `vm-${projectId}`,
    snapshotPath: `/snap/${projectId}.vmstate`,
    memFilePath: `/snap/${projectId}.mem`,
    rootfs: `/run/${projectId}.rootfs.ext4`,
    net,
    vcpus: 2,
    memoryMB: 1024,
    bytesMem: 1_000,
    bytesState: 100,
    bytesRootfs: 5_000,
    createdAt: 1000,
    suspendedAt: 1000,
    lastAccessAt: 1000,
    rootfsIdentity: 'id-1',
    v: 1,
    ...over,
  }
}

describe('CacheIndex', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idx-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('put/get round-trips an entry', () => {
    const idx = new CacheIndex(dir)
    idx.put(entry('proj-a'))
    expect(idx.get('proj-a')?.vmId).toBe('vm-proj-a')
    expect(idx.get('missing')).toBeNull()
  })

  test('all() returns every valid entry and survives a fresh instance (restart)', () => {
    const idx = new CacheIndex(dir)
    idx.put(entry('a'))
    idx.put(entry('b'))
    // Simulate a node-agent restart: a brand new index over the same dir.
    const reopened = new CacheIndex(dir)
    const ids = reopened.all().map((e) => e.projectId).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  test('touch updates lastAccessAt', () => {
    const idx = new CacheIndex(dir)
    idx.put(entry('a', { lastAccessAt: 1 }))
    idx.touch('a', 999)
    expect(idx.get('a')?.lastAccessAt).toBe(999)
  })

  test('remove deletes the entry', () => {
    const idx = new CacheIndex(dir)
    idx.put(entry('a'))
    idx.remove('a')
    expect(idx.get('a')).toBeNull()
    expect(idx.all()).toEqual([])
  })

  test('projectIds with unsafe filename chars are handled', () => {
    const idx = new CacheIndex(dir)
    const pid = 'org/team:proj 1'
    idx.put(entry(pid))
    expect(idx.get(pid)?.projectId).toBe(pid)
    expect(idx.all().map((e) => e.projectId)).toContain(pid)
  })
})
