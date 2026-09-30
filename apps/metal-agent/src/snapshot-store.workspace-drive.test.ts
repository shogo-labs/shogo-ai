// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The workspace drive's trip through the durable store: packed sparse on push,
 * restored sparse at the exact path the vmstate expects on pull. Uses the fs
 * backend (same pack/unpack as S3) with real tar/gzip.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { allocatedBytes } from './disk'
import {
  WORKSPACE_DRIVE_ARTIFACT,
  createSnapshotStore,
  packSparseFile,
  unpackSparseFile,
  type SnapshotMeta,
} from './snapshot-store'

const net = {
  tap: 'fctap0',
  hostIp: '172.16.0.1',
  guestIp: '172.16.0.2',
  netmask: '255.255.255.252',
  guestMac: '06:00:AC:10:00:02',
  bootIpArg: 'ip=...',
}

const MARK_AT = 300 * 1024 * 1024
const SIZE = 512 * 1024 * 1024
const SLOW = 60_000

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-drive-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A 512 MiB sparse "drive" with a marker written deep inside it. */
function makeDrive(path: string, marker: string): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, Buffer.from(marker), 0, marker.length, MARK_AT)
    writeSync(fd, Buffer.from('tail'), 0, 4, SIZE - 4)
  } finally {
    closeSync(fd)
  }
}

function readAt(path: string, pos: number, len: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    require('fs').readSync(fd, buf, 0, len, pos)
    return buf.toString()
  } finally {
    closeSync(fd)
  }
}

function makeStore() {
  return createSnapshotStore({ ...config, snapStore: 'fs', snapStoreDir: join(dir, 'durable'), snapSlim: false } as any)
}

function artifacts(name: string) {
  const local = join(dir, 'local')
  mkdirSync(local, { recursive: true })
  const files = {
    vmstate: join(local, `${name}.vmstate`),
    mem: join(local, `${name}.mem`),
    rootfs: join(local, `${name}.cow`),
  }
  for (const p of Object.values(files)) writeFileSync(p, `${name}-bytes`)
  return files
}

function meta(projectId: string, rootfsPath: string): SnapshotMeta {
  return {
    projectId,
    net,
    vcpus: 2,
    memoryMB: 1024,
    bytesMem: 1,
    bytesState: 1,
    createdAt: 1,
    rootfsPath,
    rootfsIdentity: 'id-1',
    rootfsMode: 'diff',
    v: 1,
  }
}

describe('sparse pack/unpack', () => {
  test('round-trips byte-exact and stays sparse', async () => {
    const src = join(dir, 'src.ws.ext4')
    makeDrive(src, 'MARKER')
    const tgz = join(dir, 'a.tgz')
    await packSparseFile(src, tgz)
    expect(statSync(tgz).size).toBeLessThan(1024 * 1024)

    const dest = join(dir, 'out', 'dest.ws.ext4')
    await unpackSparseFile(tgz, dest)
    expect(statSync(dest).size).toBe(SIZE)
    expect(allocatedBytes(dest)).toBeLessThan(64 * 1024 * 1024)
    expect(readAt(dest, MARK_AT, 6)).toBe('MARKER')
    expect(readAt(dest, SIZE - 4, 4)).toBe('tail')
  }, SLOW)

  test('a corrupt archive leaves nothing at the destination', async () => {
    const tgz = join(dir, 'bad.tgz')
    writeFileSync(tgz, 'not a gzip')
    const dest = join(dir, 'out', 'dest.ws.ext4')
    mkdirSync(join(dir, 'out'), { recursive: true })
    await expect(unpackSparseFile(tgz, dest)).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(join(dir, 'out'))).toEqual([])
  })
})

describe('durable store with a workspace drive', () => {
  test('push records the drive and pull restores it at the vmstate path', async () => {
    const store = makeStore()
    const drivePath = join(dir, 'run', 'fcvm-1-abc.ws.ext4')
    mkdirSync(join(dir, 'run'), { recursive: true })
    makeDrive(drivePath, 'PROJECT')
    const files = artifacts('p1')
    await store.push({ ...files, workspaceDrive: drivePath }, meta('p1', files.rootfs))

    const head = await store.head('p1')
    expect(head?.workspaceDrive).toEqual({ path: drivePath, bytes: SIZE })
    expect(existsSync(join(dir, 'durable', config.snapStorePrefix, 'p1', WORKSPACE_DRIVE_ARTIFACT))).toBe(true)

    // Another host: nothing local survives.
    rmSync(join(dir, 'run'), { recursive: true, force: true })
    rmSync(join(dir, 'local'), { recursive: true, force: true })
    const pulled = await store.pull('p1', join(dir, 'pulled'), 'id-1')
    expect(pulled?.files.workspaceDrive).toBe(drivePath)
    expect(readAt(drivePath, MARK_AT, 7)).toBe('PROJECT')
    expect(allocatedBytes(drivePath)).toBeLessThan(64 * 1024 * 1024)
    // Stamped now, so the orphan sweep's age gate spares it mid-restore.
    expect(Date.now() - statSync(drivePath).mtimeMs).toBeLessThan(60_000)
  }, SLOW)

  test('a snapshot without a drive pulls as before and clears a stale artifact', async () => {
    const store = makeStore()
    const drivePath = join(dir, 'old.ws.ext4')
    makeDrive(drivePath, 'OLD')
    const first = artifacts('p2')
    await store.push({ ...first, workspaceDrive: drivePath }, meta('p2', first.rootfs))

    const second = artifacts('p2')
    await store.push(second, meta('p2', second.rootfs))
    expect((await store.head('p2'))?.workspaceDrive).toBeUndefined()
    expect(existsSync(join(dir, 'durable', config.snapStorePrefix, 'p2', WORKSPACE_DRIVE_ARTIFACT))).toBe(false)

    const pulled = await store.pull('p2', join(dir, 'pulled'), 'id-1')
    expect(pulled?.files.workspaceDrive).toBeUndefined()
  }, SLOW)
})
