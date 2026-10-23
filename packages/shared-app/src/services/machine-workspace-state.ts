// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Machine-workspace state (SHO-185)
 *
 * A workspace that lives on a paired Mac is read from the cloud copy and written
 * through the tunnel. When the Mac is asleep or its runtime is still starting,
 * the cloud answers with one of the codes in `MACHINE_ERROR_CODES` instead of a
 * bare failure — and the UI has to say which of the three things is true:
 *
 *   • waking / runtime_starting — coming up, try again in `Retry-After`
 *   • machine_offline_readonly  — asleep: reads work, writes are refused
 *   • anything else             — a real error, shown as one
 *
 * Two pieces live here so a screen never re-derives them:
 *
 *   • `MachineWorkspaceStateStore` — the state, moved by whatever request last
 *     failed, with the retry policy (honour `Retry-After`, back off, cap at 60s).
 *   • `describeMachineWorkspace` — the words and the flags a banner and a
 *     composer need, given that state. Pure, so every state has a test.
 */

import {
  MACHINE_ERROR_CODES,
  isMachineOfflineReadOnly,
  isMachineWakeError,
} from './remote-http-interceptor'

/** Never wait longer than this for the machine, whatever the server asks. */
export const MACHINE_RETRY_CAP_MS = 60_000
/** First retry when the server sends no `Retry-After`. */
export const MACHINE_RETRY_BASE_MS = 1_500

export type MachineWorkspaceCondition =
  | { kind: 'ok' }
  | { kind: 'waking'; retryAfterMs: number; attempt: number }
  // `lastSyncedAt` rides on the 409 the API answers with, so the banner can say
  // when the copy was last fed without a second request.
  | { kind: 'offline'; lastSyncedAt: string | null }

export type MachineWorkspaceTone = 'none' | 'waking' | 'offline'

export interface MachineWorkspaceView {
  /** The line above the composer; null when the workspace needs no notice. */
  banner: string | null
  tone: MachineWorkspaceTone
  /** Writes are refused until the machine is back. */
  composeDisabled: boolean
  /** How long until the next automatic retry, when there is one. */
  retryAfterMs: number | null
}

/** How a last-sync timestamp reads under the banner. */
export function describeLastSynced(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return 'never'
  const ms = now - at
  // A clock that disagrees with the cloud should say "just now", not "-3m ago".
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * What the screen shows for a given condition.
 *
 * The machine's name is the person's own name for it ("Russell's MacBook"), and
 * it falls back to "your Mac" rather than an id or an empty gap.
 */
export function describeMachineWorkspace(
  condition: MachineWorkspaceCondition,
  options: { machineName?: string | null; lastSyncedAt?: string | null; now?: number } = {},
): MachineWorkspaceView {
  const name = options.machineName?.trim() || 'Your Mac'
  if (condition.kind === 'offline') {
    const lastSyncedAt = options.lastSyncedAt ?? condition.lastSyncedAt ?? null
    return {
      banner: `${name} is offline — last synced ${describeLastSynced(lastSyncedAt, options.now)}`,
      tone: 'offline',
      composeDisabled: true,
      retryAfterMs: null,
    }
  }
  if (condition.kind === 'waking') {
    return {
      banner: `Waking ${name}…`,
      tone: 'waking',
      composeDisabled: true,
      retryAfterMs: condition.retryAfterMs,
    }
  }
  return { banner: null, tone: 'none', composeDisabled: false, retryAfterMs: null }
}

// ─── Reading a failed request ────────────────────────────────────────────────

interface ErrorShape {
  status?: number
  statusCode?: number
  code?: string
  retryAfter?: string | number
  headers?: { get?: (name: string) => string | null } | Record<string, string>
  /**
   * The SDK's `ShogoError` keeps the response body here. Its `code` is the HTTP
   * status map (`409 → 'CONFLICT'`, `503 → 'UNKNOWN'`), *not* the API's own
   * code — reading `code` first is what made every machine state classify as
   * `ok` while the banner's tests, which built plain `{ status, code }`
   * objects, kept passing.
   */
  details?: any
  body?: any
  response?: { status?: number; data?: any; headers?: any }
}

/** The API's own error object, wherever this runtime put the body. */
function errorDetail(error: unknown): any {
  const e = (error ?? {}) as ErrorShape
  const candidates = [e.details, e.body, e.response?.data]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.error && typeof candidate.error === 'object') return candidate.error
    if (typeof candidate.code === 'string') return candidate
  }
  return null
}

function errorStatus(error: unknown): number | null {
  const e = (error ?? {}) as ErrorShape
  const status = e.status ?? e.statusCode ?? e.response?.status
  return typeof status === 'number' ? status : null
}

function errorCode(error: unknown): string | null {
  // The body first: the thrown `code` is the status map, never the machine code.
  const detail = errorDetail(error)
  if (detail && typeof detail.code === 'string') return detail.code
  const e = (error ?? {}) as ErrorShape
  return typeof e.code === 'string' ? e.code : null
}

/** When the copy was last fed, from the offline 409. */
export function errorLastSyncedAt(error: unknown): string | null {
  const detail = errorDetail(error)
  const value = detail?.lastSyncedAt
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `retryAfterSeconds` from the body, in ms. */
function errorRetryAfterSeconds(error: unknown): number | null {
  const detail = errorDetail(error)
  const value = detail?.retryAfterSeconds
  if (typeof value === 'number' && Number.isFinite(value)) return clampRetry(value * 1000)
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return clampRetry(Number(value) * 1000)
  }
  return null
}

function headerValue(error: unknown, name: string): string | null {
  const e = (error ?? {}) as ErrorShape
  const headers = e.headers
  if (!headers) return null
  if (typeof (headers as any).get === 'function') {
    const value = (headers as any).get(name)
    return typeof value === 'string' ? value : null
  }
  const record = headers as Record<string, string>
  return record[name] ?? record[name.toLowerCase()] ?? null
}

/** `Retry-After` as milliseconds: seconds or an HTTP date, capped at 60s. */
export function parseRetryAfter(
  value: string | number | null | undefined,
  now = Date.now(),
): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return clampRetry(value * 1000)
  const trimmed = value.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return clampRetry(seconds * 1000)
  const date = new Date(trimmed).getTime()
  if (Number.isFinite(date)) return clampRetry(date - now)
  return null
}

function clampRetry(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.min(ms, MACHINE_RETRY_CAP_MS)
}

/** True when the failure is one of the machine's three states, not a real error. */
export function isMachineConditionError(error: unknown): boolean {
  const status = errorStatus(error)
  const code = errorCode(error)
  if (status === null) return false
  return (
    isMachineWakeError(status, code) ||
    isMachineOfflineReadOnly(status, code) ||
    code === MACHINE_ERROR_CODES.machineTimeout
  )
}

// ─── The store a screen subscribes to ────────────────────────────────────────

type Listener = (condition: MachineWorkspaceCondition) => void

/**
 * The machine workspace's state, kept in one place.
 *
 * Only ever moved by a request that came back with a machine code, or by a
 * successful retry (`markOk`), so the banner cannot linger after the Mac is
 * back: the first request that succeeds clears it.
 */
export class MachineWorkspaceStateStore {
  private condition: MachineWorkspaceCondition = { kind: 'ok' }
  private listeners = new Set<Listener>()
  private attempt = 0

  get(): MachineWorkspaceCondition {
    return this.condition
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(next: MachineWorkspaceCondition): MachineWorkspaceCondition {
    this.condition = next
    for (const listener of this.listeners) listener(next)
    return next
  }

  /** A request succeeded: the machine is back and the banner goes away. */
  markOk(): void {
    this.attempt = 0
    if (this.condition.kind !== 'ok') this.set({ kind: 'ok' })
  }

  /**
   * Classify a failed request. Returns the condition it produced, or the current
   * one unchanged when the error is not a machine state (a real error belongs to
   * the screen that made the request, not to a global banner).
   */
  report(error: unknown, now = Date.now()): MachineWorkspaceCondition {
    const status = errorStatus(error)
    const code = errorCode(error)

    if (status !== null && isMachineOfflineReadOnly(status, code)) {
      this.attempt = 0
      return this.set({ kind: 'offline', lastSyncedAt: errorLastSyncedAt(error) })
    }

    if (status !== null && isMachineWakeError(status, code)) {
      this.attempt += 1
      const asked =
        errorRetryAfterSeconds(error) ?? parseRetryAfter(headerValue(error, 'retry-after'), now)
      const backoff = Math.min(
        MACHINE_RETRY_CAP_MS,
        MACHINE_RETRY_BASE_MS * Math.pow(2, this.attempt - 1),
      )
      return this.set({ kind: 'waking', retryAfterMs: asked ?? backoff, attempt: this.attempt })
    }

    return this.condition
  }

  reset(): void {
    this.attempt = 0
    this.set({ kind: 'ok' })
  }
}

/** The app-wide state: one workspace's machine is the one on screen. */
export const machineWorkspaceState = new MachineWorkspaceStateStore()
