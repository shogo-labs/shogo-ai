// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for consistent writable-state capture.
 *
 * The two properties worth proving here are the ones that caused real data
 * loss, so both are exercised against a live database rather than a mock:
 *
 *   1. A snapshot taken while another process is committing is INTERNALLY
 *      CONSISTENT — never a mix of pre- and post-transaction pages.
 *   2. Restoring a snapshot next to a leftover `-wal` silently REVERTS it.
 *      This one is not theoretical; see the test for what SQLite actually
 *      reports afterwards.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  archiveNeedsSidecarClear,
  clearSqliteSidecars,
  closeWritableStateHandles,
  packWritableState,
  snapshotSqlite,
  SQLITE_DB_REL,
  writableStateTag,
} from '../writable-state'

const dirs: string[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'writable-state-'))
  dirs.push(d)
  return d
}

/** A workspace with a WAL-mode database at `prisma/dev.db`. */
function workspaceWithDb(rows = 3): { ws: string; dbPath: string } {
  const ws = scratch()
  mkdirSync(join(ws, 'prisma'), { recursive: true })
  const dbPath = join(ws, SQLITE_DB_REL)
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE t(v TEXT)')
  for (let i = 0; i < rows; i++) db.exec("INSERT INTO t VALUES('row')")
  db.close()
  return { ws, dbPath }
}

async function entriesOf(archive: string): Promise<string[]> {
  const tar = await import('tar')
  const names: string[] = []
  await tar.list({ file: archive, onReadEntry: (e: { path: string }) => names.push(e.path) })
  return names
}

afterEach(() => {
  closeWritableStateHandles()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('snapshotSqlite', () => {
  test('produces a standalone database that needs no sidecars', () => {
    const { ws, dbPath } = workspaceWithDb(5)
    const out = join(scratch(), 'snap.db')

    snapshotSqlite(dbPath, out)

    // No WAL is emitted alongside the snapshot — that is what makes it safe to
    // ship as a single file, and why the restore side must clear stale ones.
    expect(existsSync(out)).toBe(true)
    expect(existsSync(`${out}-wal`)).toBe(false)

    const restored = new Database(out, { readonly: true })
    expect(restored.query('SELECT count(*) n FROM t').get()).toEqual({ n: 5 })
    expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    restored.close()
    expect(ws).toBeTruthy()
  })

  test('is transactionally consistent while another process commits', async () => {
    const { ws, dbPath } = workspaceWithDb(0)

    // Two balances moved in ONE transaction. Their sum is invariant, so any
    // snapshot that captured half of a transaction is detectable — which is
    // exactly the failure mode of tarring the file while a writer runs.
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE acct(id INTEGER PRIMARY KEY, bal INTEGER)')
    seed.exec('INSERT INTO acct VALUES (1, 500), (2, 500)')
    seed.close()

    const writerSrc = join(ws, 'writer.ts')
    writeFileSync(
      writerSrc,
      `import { Database } from 'bun:sqlite'
       const db = new Database(${JSON.stringify(dbPath)})
       db.exec('PRAGMA journal_mode=WAL')
       db.exec('PRAGMA busy_timeout = 5000')
       const move = db.transaction(() => {
         db.exec('UPDATE acct SET bal = bal - 1 WHERE id = 1')
         db.exec('UPDATE acct SET bal = bal + 1 WHERE id = 2')
         db.exec('UPDATE acct SET bal = bal + 1 WHERE id = 1')
         db.exec('UPDATE acct SET bal = bal - 1 WHERE id = 2')
       })
       while (true) move()
      `,
    )
    const writer = Bun.spawn(['bun', writerSrc], { stdout: 'ignore', stderr: 'ignore' })

    try {
      await Bun.sleep(150)
      const snapDir = scratch()
      let taken = 0
      for (let i = 0; i < 8; i++) {
        const out = join(snapDir, `snap-${i}.db`)
        snapshotSqlite(dbPath, out)
        const s = new Database(out, { readonly: true })
        try {
          expect(s.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
          // The invariant: never a half-applied transaction.
          expect(s.query('SELECT sum(bal) total FROM acct').get()).toEqual({ total: 1000 })
          taken++
        } finally {
          s.close()
        }
        await Bun.sleep(20)
      }
      expect(taken).toBe(8)
    } finally {
      writer.kill()
      await writer.exited
    }
  }, 20_000)
})

describe('writableStateTag', () => {
  test('is null when the project has no writable state', () => {
    expect(writableStateTag(scratch())).toBeNull()
  })

  test('is stable while nothing changes', () => {
    const { ws } = workspaceWithDb()
    expect(writableStateTag(ws)).toBe(writableStateTag(ws) as string)
  })

  test('changes after a commit by another connection', () => {
    const { ws, dbPath } = workspaceWithDb()
    const before = writableStateTag(ws)

    const db = new Database(dbPath)
    db.exec("INSERT INTO t VALUES('added')")
    db.close()

    expect(writableStateTag(ws)).not.toBe(before as string)
  })

  test('changes when an upload appears or is modified', () => {
    const { ws } = workspaceWithDb()
    const uploads = join(ws, 'uploads')
    mkdirSync(uploads, { recursive: true })

    const empty = writableStateTag(ws)
    writeFileSync(join(uploads, 'a.bin'), 'one')
    const added = writableStateTag(ws)
    expect(added).not.toBe(empty as string)

    writeFileSync(join(uploads, 'a.bin'), 'one-longer')
    expect(writableStateTag(ws)).not.toBe(added as string)
  })

  test('releases its handle when the database is deleted', () => {
    const { ws, dbPath } = workspaceWithDb(2)
    expect(writableStateTag(ws)).not.toBeNull()

    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })

    expect(writableStateTag(ws)).toBeNull()
    // And it recovers rather than reporting a frozen tag from the dead handle.
    const fresh = new Database(dbPath)
    fresh.exec('CREATE TABLE t(v TEXT)')
    fresh.close()
    expect(writableStateTag(ws)).not.toBeNull()
  })

  test('survives the database being recreated under it', () => {
    // `prisma migrate reset` replaces the file, giving a new inode. A cached
    // read handle pointed at the old inode would otherwise report a frozen
    // commit counter and the project would stop being backed up.
    const { ws, dbPath } = workspaceWithDb(2)
    const before = writableStateTag(ws)

    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    const fresh = new Database(dbPath)
    fresh.exec('CREATE TABLE t(v TEXT)')
    fresh.exec("INSERT INTO t VALUES('brand new')")
    fresh.close()

    const after = writableStateTag(ws)
    expect(after).not.toBe(before as string)

    // And it keeps tracking the NEW file rather than going stale again.
    const db = new Database(dbPath)
    db.exec("INSERT INTO t VALUES('more')")
    db.close()
    expect(writableStateTag(ws)).not.toBe(after as string)
  })
})

describe('packWritableState', () => {
  test('returns null when there is nothing to persist', async () => {
    const pack = await packWritableState({
      workspaceDir: scratch(),
      stageDir: scratch(),
      outPath: join(scratch(), 'out.tgz'),
    })
    expect(pack).toBeNull()
  })

  test('archives the database snapshot and upload dirs, never the sidecars', async () => {
    const { ws } = workspaceWithDb(4)
    mkdirSync(join(ws, 'uploads'), { recursive: true })
    writeFileSync(join(ws, 'uploads', 'song.mp3'), 'audio')
    // A live WAL exists in the workspace and must not be picked up.
    const live = new Database(join(ws, SQLITE_DB_REL))
    live.exec("INSERT INTO t VALUES('uncheckpointed')")
    live.close()
    expect(existsSync(join(ws, 'prisma/dev.db-wal'))).toBe(true)

    const out = join(scratch(), 'out.tgz')
    const pack = await packWritableState({ workspaceDir: ws, stageDir: scratch(), outPath: out })

    expect(pack).not.toBeNull()
    expect(pack!.paths).toEqual([SQLITE_DB_REL, 'uploads'])

    const entries = await entriesOf(out)
    expect(entries).toContain(SQLITE_DB_REL)
    expect(entries).toContain('uploads/song.mp3')
    expect(entries.some((e) => e.includes('-wal') || e.includes('-shm'))).toBe(false)
  })

  test('captures data committed but still sitting in the WAL', async () => {
    // The sidecars are excluded, so the snapshot — not the file copy — is what
    // has to carry these rows. If it did not, excluding the WAL would lose data.
    const { ws } = workspaceWithDb(1)
    const live = new Database(join(ws, SQLITE_DB_REL))
    live.exec("INSERT INTO t VALUES('in wal')")
    live.close()

    const out = join(scratch(), 'out.tgz')
    await packWritableState({ workspaceDir: ws, stageDir: scratch(), outPath: out })

    const dest = scratch()
    const tar = await import('tar')
    await tar.extract({ file: out, cwd: dest })
    const restored = new Database(join(dest, SQLITE_DB_REL), { readonly: true })
    expect(restored.query('SELECT count(*) n FROM t').get()).toEqual({ n: 2 })
    restored.close()
  })

  test('a write landing after the pack still forces a re-export', async () => {
    // The ordering that matters: the archive's tag must never describe state
    // newer than the archive itself, or the next cycle answers "unchanged" and
    // that write is never backed up.
    const { ws } = workspaceWithDb(1)
    const pack = await packWritableState({
      workspaceDir: ws,
      stageDir: scratch(),
      outPath: join(scratch(), 'out.tgz'),
    })

    const db = new Database(join(ws, SQLITE_DB_REL))
    db.exec("INSERT INTO t VALUES('after the pack')")
    db.close()

    expect(writableStateTag(ws)).not.toBe(pack!.tag as string)
  })

  test('writes no scratch files into the live workspace', async () => {
    // Staging inside the workspace would trip the preview file watcher and
    // trigger a rebuild on every export cycle.
    const { ws } = workspaceWithDb(2)
    const before = statSync(join(ws, 'prisma')).mtimeMs
    const listBefore = new Set(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: ws })))

    await packWritableState({
      workspaceDir: ws,
      stageDir: scratch(),
      outPath: join(scratch(), 'out.tgz'),
    })

    const listAfter = new Set(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: ws })))
    expect([...listAfter].filter((f) => !listBefore.has(f))).toEqual([])
    expect(before).toBeGreaterThan(0)
  })
})

/**
 * A workspace whose `prisma/dev.db-wal` still holds LIVE (un-checkpointed)
 * frames — the state a rootfs image is in when the VM it was captured from
 * never closed its database. Copying while the connection is open is what
 * makes the WAL live; a clean `close()` checkpoints and neutralises it, which
 * is why this cannot be written the obvious way.
 */
function templateFrozenWithLiveWal(rows: number): string {
  const src = scratch()
  mkdirSync(join(src, 'prisma'), { recursive: true })
  const srcDb = join(src, SQLITE_DB_REL)
  const db = new Database(srcDb)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE t(v TEXT)')
  for (let i = 0; i < rows; i++) db.exec("INSERT INTO t VALUES('template')")

  const ws = scratch()
  mkdirSync(join(ws, 'prisma'), { recursive: true })
  for (const rel of [SQLITE_DB_REL, 'prisma/dev.db-wal', 'prisma/dev.db-shm']) {
    if (existsSync(join(src, rel))) copyFileSync(join(src, rel), join(ws, rel))
  }
  db.close()
  return ws
}

/** Snapshot archive of a separate workspace holding the user's real data. */
async function realDataArchive(rows: number): Promise<string> {
  const realWs = scratch()
  mkdirSync(join(realWs, 'prisma'), { recursive: true })
  const realDb = new Database(join(realWs, SQLITE_DB_REL))
  realDb.exec('CREATE TABLE t(v TEXT)')
  for (let i = 0; i < rows; i++) realDb.exec("INSERT INTO t VALUES('users data')")
  realDb.close()
  const out = join(scratch(), 'out.tgz')
  await packWritableState({ workspaceDir: realWs, stageDir: scratch(), outPath: out })
  return out
}

describe('stale sidecar handling on restore', () => {
  test('a leftover WAL silently REVERTS a restored snapshot', async () => {
    // The motivating failure, reproduced end to end. Note what SQLite reports
    // afterwards: not an error, not a corrupt database — a perfectly healthy
    // one holding the WRONG data. Nothing downstream can detect this.
    const ws = templateFrozenWithLiveWal(3)
    const out = await realDataArchive(10)

    const tar = await import('tar')
    await tar.extract({ file: out, cwd: ws })

    const reverted = new Database(join(ws, SQLITE_DB_REL))
    expect(reverted.query('SELECT count(*) n FROM t').get()).toEqual({ n: 3 })
    expect(reverted.query('SELECT DISTINCT v FROM t').all()).toEqual([{ v: 'template' }])
    expect(reverted.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    reverted.close()
  })

  test('clearing the sidecars first preserves the restored data', async () => {
    const ws = templateFrozenWithLiveWal(3)
    const out = await realDataArchive(10)

    const tar = await import('tar')
    await tar.extract({ file: out, cwd: ws })
    expect(archiveNeedsSidecarClear(await entriesOf(out))).toBe(true)
    expect(clearSqliteSidecars(ws).sort()).toEqual(['prisma/dev.db-shm', 'prisma/dev.db-wal'])

    const restored = new Database(join(ws, SQLITE_DB_REL))
    expect(restored.query('SELECT count(*) n FROM t').get()).toEqual({ n: 10 })
    expect(restored.query('SELECT DISTINCT v FROM t').all()).toEqual([{ v: 'users data' }])
    expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    restored.close()
  })

  test('archiveNeedsSidecarClear leaves legacy db+wal archives alone', () => {
    expect(archiveNeedsSidecarClear([SQLITE_DB_REL, 'uploads/a'])).toBe(true)
    expect(archiveNeedsSidecarClear(['./prisma/dev.db'])).toBe(true)
    expect(archiveNeedsSidecarClear([SQLITE_DB_REL, 'prisma/dev.db-wal'])).toBe(false)
    expect(archiveNeedsSidecarClear(['uploads/a', 'src/index.ts'])).toBe(false)
  })

  test('clearSqliteSidecars is a no-op when there is nothing to clear', () => {
    expect(clearSqliteSidecars(scratch())).toEqual([])
  })
})
