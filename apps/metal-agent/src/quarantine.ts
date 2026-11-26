// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The ONE place a refused export reaches `conflict/`.
 *
 * Every guarded write can end in "these bytes must not overwrite the durable
 * object", and each of the four writers (source, writable state, home, repo)
 * used to park them itself. That is how one VM adopted mid-open wrote 10,391
 * identical 525 MB copies into `conflict/` in six days: nothing deduped them,
 * nothing capped them, and every retry of a recycle that could not succeed
 * made four more. `conflict/` is the largest thing in the workspaces bucket
 * (6.2 TB / 208k objects), and none of it was ever useful twice.
 *
 * So the quarantine decision lives here, at the insert point, and every writer
 * goes through it:
 *
 *   - DEDUPE: the last copy per `(projectId, kind)` is remembered as
 *     `{ size, sha256, key }`. Identical bytes are not uploaded again — the
 *     previous key is returned, because the bytes are already durable.
 *   - DAILY CAP: at most `METAL_QUARANTINE_DAILY_CAP` (default 24) writes per
 *     project per UTC day, all kinds together. Over the cap nothing is written
 *     and `null` is returned, which every caller already treats as "not
 *     saved": a capped export can never let a VM be destroyed or rotated.
 *
 * The state is persisted with the VM's live registry entry (see `writeLive`),
 * so an agent restart does not reset the counter — twelve restarts a day would
 * otherwise mean twelve fresh caps, which is the same unbounded loop.
 */

import { createHash } from 'crypto'
import type { MetalConfig } from './config'
import { M, metrics } from './metrics'

/** Which archive a quarantine copy belongs to. One dedupe slot per kind. */
export type QuarantineKind = 'source' | 'data' | 'home' | 'repo'

/** The last copy written for one `(projectId, kind)`, for dedupe. */
export interface QuarantineCopy {
  size: number
  sha256: string
  key: string
}

/**
 * Per-project quarantine bookkeeping. Lives on the AssignedVm and in its live
 * registry entry, so the cap and the dedupe slots survive a deploy.
 */
export interface QuarantineState {
  last?: Partial<Record<QuarantineKind, QuarantineCopy>>
  /** UTC date (YYYY-MM-DD) `writes` counts against. */
  day?: string
  /** Quarantine writes made on `day`. */
  writes?: number
}

/** Default cap: 24 quarantine writes per project per UTC day. */
export const QUARANTINE_DAILY_CAP_DEFAULT = 24

/**
 * The bookkeeping a caller threads through an archive write: the persisted
 * per-project state, and a hook to persist it after every change.
 */
export interface QuarantineBookkeeping {
  state?: QuarantineState
  onChange?: (state: QuarantineState) => void
}

/** Configured daily cap, ignoring a nonsense value. */
export function quarantineDailyCap(cfg: MetalConfig): number {
  const cap = cfg.quarantineDailyCap
  return Number.isFinite(cap) && cap >= 0 ? cap : QUARANTINE_DAILY_CAP_DEFAULT
}

/** UTC day a timestamp falls in, the bucket the cap counts against. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Projects already logged as capped today, so one line per project per day. */
const cappedLogged = new Set<string>()

/**
 * The bytes being parked, described so the helper can dedupe without holding
 * them twice: the size is cheap, and the digest is only computed when the size
 * ALREADY matches the last copy of that kind (a repo archive can be gigabytes
 * and lives on disk, so hashing every export would cost more than the PUT).
 */
export interface QuarantineBody {
  size: number
  sha256(): Promise<string>
}

/** A body already in memory (source, writable state, home). */
export function memoryBody(bytes: Uint8Array): QuarantineBody {
  return {
    size: bytes.byteLength,
    sha256: async () => createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * Park `bytes` at `key` unless they are already durable or this project is over
 * its daily cap.
 *
 * Returns the key the bytes live at (the new one, or the earlier identical
 * copy's), or `null` when nothing could be written — the caller must treat
 * `null` as NOT SAVED.
 */
export async function quarantinedCopy(opts: {
  projectId: string
  kind: QuarantineKind
  body: QuarantineBody
  /** Destination key, chosen by the caller (each kind keeps its own naming). */
  key: string
  /** Does the actual store write. Called at most once per call. */
  write: (key: string) => Promise<void>
  /** The project's persisted bookkeeping; mutated in place. */
  state?: QuarantineState
  /** Called after any state change so the caller can persist it. */
  onChange?: (state: QuarantineState) => void
  dailyCap: number
  now?: number
}): Promise<string | null> {
  const size = opts.body.size
  const state = opts.state ?? {}
  // The digest is needed twice on the write path (dedupe, then recording) and a
  // repo archive can be gigabytes, so it is computed at most once per call.
  let digest: string | undefined
  const sha256 = async (): Promise<string> => (digest ??= await opts.body.sha256())

  const previous = state.last?.[opts.kind]
  if (previous && previous.size === size && previous.sha256 === (await sha256())) {
    metrics.inc(`${M.quarantineDeduped}{kind="${opts.kind}"}`)
    return previous.key
  }

  const day = utcDay(opts.now)
  if (state.day !== day) {
    state.day = day
    state.writes = 0
  }
  if ((state.writes ?? 0) >= opts.dailyCap) {
    metrics.inc(`${M.quarantineCapped}{kind="${opts.kind}"}`)
    const logKey = `${opts.projectId}:${day}`
    if (!cappedLogged.has(logKey)) {
      cappedLogged.add(logKey)
      console.error(
        `[quarantine] ${opts.projectId} is over its daily quarantine cap (${opts.dailyCap} writes on ${day}); ` +
          `not writing ${size} bytes of ${opts.kind}. The refused copy is NOT saved — the VM must not be ` +
          `destroyed or rotated on the strength of it.`,
      )
    }
    opts.onChange?.(state)
    return null
  }

  const digestHex = await sha256()
  await opts.write(opts.key)
  state.writes = (state.writes ?? 0) + 1
  state.last = { ...state.last, [opts.kind]: { size, sha256: digestHex, key: opts.key } }
  opts.onChange?.(state)
  metrics.inc(`${M.quarantineBytes}{kind="${opts.kind}"}`, size)
  return opts.key
}
