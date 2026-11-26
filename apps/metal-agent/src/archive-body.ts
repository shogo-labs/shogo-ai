// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A guest export on its way to the durable store: in memory, or spooled to disk.
 *
 * The repo export already works this way ({@link RepoBody}); source, writable
 * state and home did not, and buffered the whole archive. That is fine for the
 * median project and was fatal for the tail: on 2026-11-26 one guest packed a
 * 4.3 GB source archive on every suspend, the host read it whole, and by 15 s in
 * the agent was holding ~33 GiB of it (SHO-593).
 *
 * The size ceiling the store enforces is not a reason to buffer: the guest's
 * archive is already a file on its own disk, so the host writes it straight back
 * out to a file and uploads from there. Only the byte count and the digest are
 * ever needed in memory, and both stream.
 */

import { createHash } from 'node:crypto'

import type { BunFile } from 'bun'

export type ArchiveBody = Uint8Array | BunFile

export function archiveBodySize(body: ArchiveBody): number {
  return body instanceof Uint8Array ? body.byteLength : body.size
}

export async function archiveBodySha256(body: ArchiveBody): Promise<string> {
  if (body instanceof Uint8Array) return createHash('sha256').update(body).digest('hex')
  const hash = createHash('sha256')
  for await (const chunk of body.stream()) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}
