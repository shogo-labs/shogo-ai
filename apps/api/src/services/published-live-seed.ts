// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The database a still-SQLite published environment is already serving, read
 * from its durable archive (`{subdomain}/data.tar.gz`), so a first Postgres
 * publish seeds from LIVE data instead of from the builder's `prisma/dev.db`.
 *
 * Why this exists (SHO-514): `prepareEnvironmentDatabase` seeds when the
 * environment has no `dbSchema`, and every app published before its region had
 * a `projects-pg` has `dbSchema: null` while carrying real rows — sign-ups, runs,
 * uploaded records — in its published-data archive. Seeding such an environment
 * from `dev.db` would create a Postgres database holding the BUILDER's rows and
 * orphan everything the live site accumulated: exactly the loss the Postgres
 * switchover exists to prevent.
 *
 * The archive is read, never modified or deleted: it is what
 * `PUBLISH_POSTGRES=off` restores from, so the switch has to stay reversible.
 *
 * Only the database files cross over. Upload dirs (`uploads/`, `storage/`)
 * keep syncing through the existing writable-state path — they are not part of
 * a database seed, and a project's media can be far larger than the seed cap.
 */

import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { PUBLISH_DATA_BUCKET, publishS3Client } from '../lib/publish-storage'

/**
 * Largest archive this will read. A published app's whole writable state is
 * downloaded and re-archived here, so the cap is the same order as the seed SQL
 * cap (`MAX_SEED_SQL_BYTES`): a state archive bigger than this is refused by
 * name instead of failing somewhere inside a JSON body.
 */
export const MAX_LIVE_SEED_ARCHIVE_BYTES = 64 * 1024 * 1024

/**
 * The database files a seed needs. `dev.db` alone is not enough: a published
 * pod tars its files as-is, so committed rows can still be sitting in the
 * `-wal` when the snapshot was taken, and dropping it would seed a database
 * that is behind its own last write.
 */
const DATABASE_ENTRY = /^prisma\/dev\.db(-wal|-shm)?$/

export interface LiveSeedArchive {
  /** gzipped tar of just the archive's `prisma/` database files, base64. */
  archive: string
  /** Bytes of the encoded archive (what crosses the API/runtime boundary). */
  bytes: number
}

export type ReadLiveSeedArchiveResult =
  | { ok: true; value: LiveSeedArchive | null }
  | { ok: false; code: 'live_seed_too_large' | 'live_seed_unreadable'; message: string }

/**
 * Read a published environment's live SQLite database out of its durable
 * archive, as a small gzipped tar the project runtime can seed from.
 *
 * Returns `{ ok: true, value: null }` when there is nothing to preserve — no
 * `PUBLISH_DATA_BUCKET` (desktop / a cluster without published-data storage), no
 * archive yet (the app has never been live), or an archive without a database
 * (a static app, or one that only ever wrote uploads). The caller then seeds
 * from the builder's `dev.db`, which is today's behaviour and correct in those
 * cases.
 */
export async function readLiveSeedArchive(subdomain: string): Promise<ReadLiveSeedArchiveResult> {
  if (!PUBLISH_DATA_BUCKET || !subdomain) return { ok: true, value: null }

  const key = `${subdomain}/data.tar.gz`
  let contentLength = 0
  try {
    const head = await publishS3Client.send(
      new HeadObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: key }),
    )
    contentLength = Number(head.ContentLength ?? 0)
  } catch {
    // No archive: a first publish, or an app whose pod never had writable state.
    return { ok: true, value: null }
  }

  if (contentLength > MAX_LIVE_SEED_ARCHIVE_BYTES) {
    return {
      ok: false,
      code: 'live_seed_too_large',
      message:
        `The live database archive is ${(contentLength / (1024 * 1024)).toFixed(0)} MB; a switch to Postgres ` +
        `seeds at most ${MAX_LIVE_SEED_ARCHIVE_BYTES / (1024 * 1024)} MB. Keep the app on SQLite ` +
        `(PUBLISH_POSTGRES=off) or reduce the live data, then publish again.`,
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'shogo-live-seed-'))
  try {
    let archiveBytes: Uint8Array
    try {
      const res = await publishS3Client.send(
        new GetObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: key }),
      )
      archiveBytes = await res.Body!.transformToByteArray()
    } catch (err: any) {
      return {
        ok: false,
        code: 'live_seed_unreadable',
        message: `Could not download the live database archive ${key}: ${err?.message ?? err}`,
      }
    }

    const downloaded = join(workDir, 'data.tar.gz')
    await writeFile(downloaded, Buffer.from(archiveBytes))

    const tar = await import('tar')
    const dbRoot = join(workDir, 'db')
    await mkdir(dbRoot, { recursive: true })
    // A corrupt archive is NOT the same as an archive with no database: the
    // second is a static app with nothing to carry over, the first means the
    // live rows could not be read at all. Treating the corrupt one as "nothing"
    // would seed Postgres from the builder's `dev.db` — the exact loss this
    // path exists to prevent.
    try {
      // `filter` is the security boundary here: only the three database files may
      // be read out of an archive that also carries user uploads, and a traversal
      // entry does not match the pattern.
      await tar.extract({
        file: downloaded,
        cwd: dbRoot,
        filter: (path) => DATABASE_ENTRY.test(path.replace(/^\.\//, '')),
      })
    } catch (err: any) {
      return {
        ok: false,
        code: 'live_seed_unreadable',
        message: `Could not read the live database archive ${key}: ${err?.message ?? err}`,
      }
    }
    if (!existsSync(join(dbRoot, 'prisma', 'dev.db'))) return { ok: true, value: null }

    const seedPath = join(workDir, 'seed.tar.gz')
    await tar.create({ gzip: true, file: seedPath, cwd: dbRoot, portable: true }, ['prisma'])
    const seed = await readFile(seedPath)
    return { ok: true, value: { archive: seed.toString('base64'), bytes: seed.length } }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
