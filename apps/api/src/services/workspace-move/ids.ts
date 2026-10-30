// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deterministic ids for a move.
 *
 * The archive importer builds an in-memory `idMap` because an archive is one
 * shot. A move is not: it streams a 19 GB workspace in chunks, gets killed
 * mid-way and resumes, and an id map for a million rows is a 70 MB JSON blob in
 * a database column. So the target id of a source row is *derived* instead of
 * allocated — uuid v5 of (move id, source id) — which means:
 *
 *   - both sides compute the same id with no shared state;
 *   - re-sending a chunk after a dropped connection is idempotent (the same
 *     row lands on the same primary key and is skipped);
 *   - a foreign key can be rewritten on the target without knowing which table
 *     it points at, because the derivation only depends on the source id.
 */

import { createHash } from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toUuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** Any string as a stable UUID (so a non-uuid move id still namespaces). */
function asNamespaceUuid(value: string): string {
  if (UUID_RE.test(value)) return value.toLowerCase()
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/**
 * uuid v5 (SHA-1, name-based) of `sourceId` in the namespace of `moveId`.
 * Exported so the target side can derive the same id while writing a chunk.
 */
export function deriveMoveId(moveId: string, sourceId: string): string {
  if (!sourceId) return ''
  const namespace = toUuidBytes(asNamespaceUuid(moveId))
  const digest = createHash('sha1').update(namespace).update(Buffer.from(sourceId, 'utf8')).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
