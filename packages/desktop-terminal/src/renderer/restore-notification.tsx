// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Restore notification — orchestrates "boot the app, find snapshots,
 * either silent-restore + toast or prompt-and-confirm" on the
 * renderer side.
 *
 * Two surfaces:
 *
 *   - `RestoreCoordinator` — non-React state machine. Tests drive it
 *     directly via the public intents.
 *
 *   - `<RestoreNotification>` + `useRestoreNotification` hook — the
 *     React component that subscribes to the coordinator and renders
 *     either a silent-confirmation toast or an "Allow restore?"
 *     dialog depending on the configured mode.
 *
 * The coordinator does NOT spawn shells itself — it consumes a
 * narrow `RestoreClient` interface the host wires to its IPC. Same
 * pattern Phase 7's QuickFixManager uses for the buffer reader.
 */

import * as React from 'react'

// ─── snapshot summary (renderer-side) ─────────────────────────────

/**
 * A trimmed view of a SessionSnapshot — just what the renderer needs
 * to decide whether to restore + render the user-facing label. The
 * full ring stays host-side until `restore()` fires.
 */
export interface SessionSnapshotSummary {
  id: string
  workspaceHash: string
  cwd: string
  shell: string
  profileId?: string
  /** Wall-clock ms when the snapshot was written. */
  writtenAt: number
  /** Approximate size of the ring (bytes) for UI hints. */
  ringBytes: number
}

// ─── client interface (host → renderer) ───────────────────────────

export interface RestoreClient {
  /** List snapshots for this workspace. Empty when nothing to restore. */
  listSnapshots(workspaceHash: string): Promise<SessionSnapshotSummary[]>
  /**
   * Restore a snapshot. The host re-spawns a fresh shell in the
   * saved cwd, replays the ring into xterm, and returns the new
   * runtime session id. Throws on failure.
   */
  restoreSession(workspaceHash: string, snapshotId: string): Promise<{ newSessionId: string }>
  /** Discard a snapshot (user said "no thanks"). */
  discardSnapshot(workspaceHash: string, snapshotId: string): Promise<void>
}

// ─── state machine ─────────────────────────────────────────────────

export type RestoreMode = 'silent' | 'prompt'

export type RestoreState =
  | 'idle'         // not scanned yet, or nothing to restore
  | 'scanning'     // listSnapshots() in flight
  | 'offering'     // we have snapshots and mode === 'prompt'
  | 'restoring'    // accept() fired; awaiting host restore calls
  | 'done'         // restore finished (success or partial); show toast
  | 'error'        // scan or restore threw; show error toast

export interface RestoreSnapshotInfo extends SessionSnapshotSummary {
  /** True iff the renderer chose to restore it; false iff dismissed. */
  accepted?: boolean
  /** Runtime session id after restoration, when accepted + restored. */
  newSessionId?: string
}

export interface RestoreSnapshot {
  state: RestoreState
  mode: RestoreMode
  snapshots: RestoreSnapshotInfo[]
  /** Number successfully restored when state === 'done'. */
  restoredCount: number
  errorMessage: string | null
}

// ─── coordinator options ──────────────────────────────────────────

export interface RestoreCoordinatorOptions {
  client: RestoreClient
  workspaceHash: string
  /**
   * 'silent' (default) → restore every snapshot immediately on
   *   scan(), then show a confirmation toast.
   * 'prompt' → enter 'offering' state, let the user accept/dismiss.
   */
  mode?: RestoreMode
  /**
   * Drop snapshots older than maxAgeMs at scan time. Default
   * 7 days — older sessions almost never reflect intent.
   */
  maxAgeMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000

// ─── coordinator ──────────────────────────────────────────────────

export class RestoreCoordinator {
  private readonly client: RestoreClient
  private readonly workspaceHash: string
  private readonly mode: RestoreMode
  private readonly maxAgeMs: number
  private readonly now: () => number

  private snap: RestoreSnapshot
  private listeners = new Set<(s: RestoreSnapshot) => void>()
  /** True once scan() has been called (used to make it idempotent). */
  private scanned = false

  constructor(opts: RestoreCoordinatorOptions) {
    this.client = opts.client
    this.workspaceHash = opts.workspaceHash
    this.mode = opts.mode ?? 'silent'
    this.maxAgeMs = Math.max(0, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
    this.now = opts.now ?? Date.now
    this.snap = {
      state: 'idle',
      mode: this.mode,
      snapshots: [],
      restoredCount: 0,
      errorMessage: null,
    }
  }

  // ─── inspectors ────────────────────────────────────────────

  snapshot(): RestoreSnapshot { return { ...this.snap, snapshots: [...this.snap.snapshots] } }
  on(cb: (s: RestoreSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  // ─── intents ──────────────────────────────────────────────

  /**
   * Kick off the scan. Idempotent — repeated calls return the same
   * promise if a scan is already in flight, or no-op if scan already
   * happened. Resolves once the coordinator settles in
   * 'idle' / 'offering' / 'done' / 'error'.
   */
  async scan(): Promise<RestoreSnapshot> {
    if (this.scanned) return this.snapshot()
    this.scanned = true
    this.update({ state: 'scanning', errorMessage: null })
    let summaries: SessionSnapshotSummary[]
    try {
      summaries = await this.client.listSnapshots(this.workspaceHash)
    } catch (e) {
      this.update({ state: 'error', errorMessage: (e as Error).message || 'list failed' })
      return this.snapshot()
    }
    const cutoff = this.now() - this.maxAgeMs
    const fresh: RestoreSnapshotInfo[] = summaries
      .filter((s) => s.writtenAt >= cutoff)
      .sort((a, b) => b.writtenAt - a.writtenAt)
      .map((s) => ({ ...s }))
    // Stale ones are discarded eagerly so they don't pile up on disk.
    const staleIds = summaries.filter((s) => s.writtenAt < cutoff).map((s) => s.id)
    void Promise.all(staleIds.map((id) =>
      this.client.discardSnapshot(this.workspaceHash, id).catch(() => undefined),
    ))

    if (fresh.length === 0) {
      this.update({ state: 'idle', snapshots: [] })
      return this.snapshot()
    }
    if (this.mode === 'silent') {
      this.update({ state: 'restoring', snapshots: fresh })
      await this.doRestore(fresh.map((s) => s.id))
    } else {
      this.update({ state: 'offering', snapshots: fresh })
    }
    return this.snapshot()
  }

  /**
   * Accept the offered restore. Restores either all snapshots or
   * just the supplied ids. No-op outside `offering` state.
   */
  async accept(ids?: string[]): Promise<RestoreSnapshot> {
    if (this.snap.state !== 'offering') return this.snapshot()
    const targetIds = ids ?? this.snap.snapshots.map((s) => s.id)
    this.update({ state: 'restoring' })
    await this.doRestore(targetIds)
    return this.snapshot()
  }

  /**
   * Dismiss the offer. Discards all (or selected) snapshots so they
   * don't re-prompt on next boot.
   */
  async dismiss(ids?: string[]): Promise<RestoreSnapshot> {
    if (this.snap.state !== 'offering') return this.snapshot()
    const targetIds = ids ?? this.snap.snapshots.map((s) => s.id)
    await Promise.all(targetIds.map((id) =>
      this.client.discardSnapshot(this.workspaceHash, id).catch(() => undefined),
    ))
    // Update flags so the toast can show "dismissed: N".
    const updated = this.snap.snapshots.map((s) =>
      targetIds.includes(s.id) ? { ...s, accepted: false } : s)
    this.update({ state: 'done', snapshots: updated, restoredCount: 0 })
    return this.snapshot()
  }

  /** Close the toast / move to idle. Called after the user dismisses it. */
  acknowledge(): void {
    if (this.snap.state === 'done' || this.snap.state === 'error') {
      this.update({ state: 'idle', snapshots: [], restoredCount: 0, errorMessage: null })
    }
  }

  dispose(): void { this.listeners.clear() }

  // ─── internals ────────────────────────────────────────────

  private async doRestore(ids: string[]): Promise<void> {
    const updated = [...this.snap.snapshots]
    let restored = 0
    let errorMessage: string | null = null
    for (const id of ids) {
      const idx = updated.findIndex((s) => s.id === id)
      if (idx < 0) continue
      try {
        const result = await this.client.restoreSession(this.workspaceHash, id)
        updated[idx] = { ...updated[idx]!, accepted: true, newSessionId: result.newSessionId }
        restored++
      } catch (e) {
        updated[idx] = { ...updated[idx]!, accepted: false }
        errorMessage = (e as Error).message || 'restore failed'
      }
    }
    this.update({
      state: errorMessage && restored === 0 ? 'error' : 'done',
      snapshots: updated,
      restoredCount: restored,
      errorMessage,
    })
  }

  private update(patch: Partial<RestoreSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) { try { l(this.snap) } catch { /* */ } }
  }
}

// ─── React hook ────────────────────────────────────────────────────

export function useRestoreNotification(coordinator: RestoreCoordinator): RestoreSnapshot {
  const [snap, setSnap] = React.useState<RestoreSnapshot>(coordinator.snapshot())
  React.useEffect(() => coordinator.on(setSnap), [coordinator])
  return snap
}

// ─── minimal toast component ──────────────────────────────────────

export interface RestoreNotificationProps {
  coordinator: RestoreCoordinator
  className?: string
}

const FACT_MESSAGE = 'Scrollback and working directory restored. Running processes did not survive the restart.'

export function RestoreNotification(props: RestoreNotificationProps): React.ReactElement | null {
  const snap = useRestoreNotification(props.coordinator)
  if (snap.state === 'idle' || snap.state === 'scanning' || snap.state === 'restoring') return null

  const isOffering = snap.state === 'offering'
  const title = isOffering
    ? `Restore ${snap.snapshots.length} terminal${snap.snapshots.length === 1 ? '' : 's'}?`
    : snap.state === 'error'
      ? 'Restore failed'
      : `Restored ${snap.restoredCount} terminal${snap.restoredCount === 1 ? '' : 's'}`

  return React.createElement(
    'div',
    {
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'shogo-restore-toast',
      'data-restore-state': snap.state,
      className: props.className,
      style: {
        position: 'absolute',
        bottom: 24, right: 24,
        zIndex: 30,
        background: 'rgba(20,20,24,0.95)',
        border: '1px solid #4a90e2',
        borderRadius: 6,
        padding: '10px 12px',
        color: '#eee',
        font: '13px / 1.4 system-ui',
        maxWidth: 360,
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
      },
    },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, title),
    React.createElement('div', { style: { opacity: 0.75, fontSize: 12 } },
      snap.state === 'error' ? (snap.errorMessage ?? 'Unknown error') : FACT_MESSAGE,
    ),
    isOffering
      ? React.createElement(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' } },
          React.createElement('button', {
            'data-testid': 'shogo-restore-dismiss',
            onClick: () => { void props.coordinator.dismiss() },
            style: buttonStyle(false),
          }, 'Discard'),
          React.createElement('button', {
            'data-testid': 'shogo-restore-accept',
            onClick: () => { void props.coordinator.accept() },
            style: buttonStyle(true),
          }, 'Restore'),
        )
      : React.createElement(
          'div',
          { style: { marginTop: 8, textAlign: 'right' } },
          React.createElement('button', {
            'data-testid': 'shogo-restore-ack',
            onClick: () => props.coordinator.acknowledge(),
            style: buttonStyle(false),
          }, 'OK'),
        ),
  )
}

function buttonStyle(primary: boolean): React.CSSProperties {
  return {
    background: primary ? '#4a90e2' : 'transparent',
    color: primary ? '#fff' : '#ccc',
    border: primary ? '1px solid #4a90e2' : '1px solid #555',
    borderRadius: 4,
    padding: '3px 10px',
    cursor: 'pointer',
    font: 'inherit',
  }
}
