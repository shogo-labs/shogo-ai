// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A durable archive described rather than downloaded.
 *
 * Hydrate used to begin by pulling the whole object into the host's memory so
 * it could be POSTed to the guest. That is what put a multi-gigabyte archive on
 * the wire in a shape the guest could not survive: Bun.serve holds a request
 * body in memory whenever the handler reads slower than it arrives, and `tar`
 * extracting gigabytes is far slower than the virtio link, so the archive
 * landed in the guest's 4 GiB and the kernel panicked. No framing on the
 * sending side fixes that, because the accumulation happens below the handler.
 *
 * What does fix it is not sending the bytes at all. The host HEADs the object
 * for the lineage ETag and size it actually needs, mints a short-lived
 * presigned GET, and hands the guest a URL. The guest pulls it through `curl`
 * into `tar`, where the kernel pipe provides the backpressure Bun's streams do
 * not. Neither process ever holds the archive.
 *
 * `load` remains for the fallback: a guest running an older runtime has no pull
 * endpoint, so the host downloads and pushes as before. That path is bounded by
 * the rollout, not by project size.
 */

import type { S3Client } from 'bun'

/** A durable archive addressed by URL, with its bytes available on demand. */
export interface ArchiveRef {
  /** ETag of the object — the lineage anchor a later write must match. */
  etag: string | null
  /** Compressed size, for the hydrate deadline and for logging. 0 if unreported. */
  bytes: number
  /**
   * Short-lived presigned GET the guest can pull from directly, or null when
   * the store cannot mint one. Null forces the push fallback; it is never a
   * reason to skip hydrating.
   */
  url: string | null
  /** Download the archive. Only the push fallback pays this. */
  load: () => Promise<Uint8Array>
}

/**
 * Describe `key` without downloading it: existence, lineage ETag, size, and a
 * presigned GET valid for `expiresInSec`.
 *
 * Returns null when the object does not exist — the caller's "nothing durable
 * to apply" case. A transport error PROPAGATES instead of reading as absent,
 * because hydrate is fail-closed: mistaking an S3 outage for "this project has
 * no backup" is how a template gets served over real source and then written
 * back over it.
 */
export async function describeObject(
  client: S3Client,
  key: string,
  expiresInSec: number,
): Promise<ArchiveRef | null> {
  const file = client.file(key)
  if (!(await file.exists())) return null

  let etag: string | null = null
  let bytes = 0
  try {
    const st = await file.stat()
    etag = st.etag ?? null
    if (typeof st.size === 'number') bytes = st.size
  } catch {
    // Size and ETag are best-effort: a missing size only costs a less precise
    // deadline, and a missing ETag costs lineage (the writer will not be able
    // to prove descent and its export quarantines) — both preferable to
    // failing a hydrate that can otherwise succeed.
  }

  return { etag, bytes, url: presign(client, key, expiresInSec), load: () => download(file) }
}

/**
 * Mint a presigned GET, or null if the client cannot.
 *
 * Never throws: presigning is an optimisation over pushing the bytes, so a
 * store that does not support it degrades to the fallback rather than failing
 * the hydrate.
 */
function presign(client: S3Client, key: string, expiresInSec: number): string | null {
  try {
    return client.file(key).presign({ expiresIn: expiresInSec, method: 'GET' })
  } catch {
    return null
  }
}

async function download(file: ReturnType<S3Client['file']>): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}
