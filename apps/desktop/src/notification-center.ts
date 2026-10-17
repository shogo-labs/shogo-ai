// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Every main-process OS notification goes through here.
//
// Two things went wrong when each call site did its own
// `const n = new Notification({...}); n.on('click', ...); n.show()`:
//
// 1. Nothing held a reference to `n`. Electron removes a notification created
//    with `new Notification()` from Notification Center as soon as the object
//    is garbage-collected, and its `click` handlers stop firing at the same
//    moment. The banner the user clicked could therefore no longer reach the
//    chat it pointed at — the handler was simply gone.
// 2. Nothing listened for `failed`, which macOS emits when the OS refuses the
//    banner (notifications denied, unsigned build). A blocked notification and
//    a delivered one were indistinguishable, so the UI reported "enabled" in
//    both cases.
//
// The center holds each notification until the OS reports it closed, records
// the outcome of the most recent attempt, and takes its constructor by
// injection so it can be tested without an Electron runtime.

export interface NotificationRequest {
  title: string
  body: string
  silent?: boolean
  actions?: Array<{ type: 'button'; text: string }>
}

/** The slice of Electron's `Notification` this module uses. */
export interface NotificationLike {
  show(): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export type DeliveryState = 'unknown' | 'shown' | 'failed'

export interface DeliveryOutcome {
  state: DeliveryState
  error?: string
  at: number
}

export interface DeliveryResult {
  ok: boolean
  reason?: string
}

export interface NotificationHandlers {
  onClick?: () => void
  onAction?: (index: number) => void
  onClose?: () => void
}

export interface NotificationCenterOptions {
  create: (request: NotificationRequest) => NotificationLike
  isSupported?: () => boolean
  now?: () => number
  log?: (message: string) => void
  /**
   * How long to hold a notification the OS never reports closed. Notifications
   * the user simply ignored would otherwise be retained for the life of the
   * process.
   */
  ttlMs?: number
  /** Cap on simultaneously retained notifications; the oldest closes first. */
  maxLive?: number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_LIVE = 50

export class NotificationCenter {
  private readonly live = new Map<number, { notification: NotificationLike; expiresAt: number }>()
  private readonly create: NotificationCenterOptions['create']
  private readonly isSupported: () => boolean
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly ttlMs: number
  private readonly maxLive: number
  private nextId = 1
  private outcome: DeliveryOutcome = { state: 'unknown', at: 0 }

  constructor(options: NotificationCenterOptions) {
    this.create = options.create
    this.isSupported = options.isSupported ?? (() => true)
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxLive = options.maxLive ?? DEFAULT_MAX_LIVE
  }

  show(request: NotificationRequest, handlers: NotificationHandlers = {}): DeliveryResult {
    this.sweep()
    if (!this.isSupported()) {
      this.record({ state: 'failed', error: 'notifications are not supported on this system', at: this.now() })
      return { ok: false, reason: 'unsupported' }
    }

    let notification: NotificationLike
    try {
      notification = this.create(request)
    } catch (err) {
      const error = (err as Error)?.message || 'notification could not be created'
      this.log(`[Notify] ${request.title}: ${error}`)
      this.record({ state: 'failed', error, at: this.now() })
      return { ok: false, reason: error }
    }

    const id = this.nextId++
    notification.on('show', () => this.record({ state: 'shown', at: this.now() }))
    notification.on('failed', (_event, error) => {
      const message = errorMessage(error)
      this.log(`[Notify] ${request.title}: delivery failed — ${message}`)
      this.release(id)
      this.record({ state: 'failed', error: message, at: this.now() })
    })
    notification.on('close', () => {
      this.release(id)
      handlers.onClose?.()
    })
    if (handlers.onClick) notification.on('click', () => handlers.onClick?.())
    if (handlers.onAction) {
      notification.on('action', (_event, index) => handlers.onAction?.(typeof index === 'number' ? index : 0))
    }

    this.live.set(id, { notification, expiresAt: this.now() + this.ttlMs })
    this.enforceCap()

    try {
      notification.show()
    } catch (err) {
      const message = errorMessage(err)
      this.log(`[Notify] ${request.title}: show() threw — ${message}`)
      this.release(id)
      this.record({ state: 'failed', error: message, at: this.now() })
      return { ok: false, reason: message }
    }
    return { ok: true }
  }

  /** Dismiss everything still on screen, e.g. on quit. */
  closeAll(): void {
    for (const id of [...this.live.keys()]) {
      const entry = this.live.get(id)
      this.release(id)
      try {
        entry?.notification.close()
      } catch {
        // Already gone.
      }
    }
  }

  /** Drop notifications the OS never reported closed. */
  sweep(): void {
    const now = this.now()
    for (const [id, entry] of [...this.live]) {
      if (entry.expiresAt > now) continue
      this.release(id)
      try {
        entry.notification.close()
      } catch {
        // Already gone.
      }
    }
  }

  getOutcome(): DeliveryOutcome {
    return { ...this.outcome }
  }

  getLiveCount(): number {
    return this.live.size
  }

  private record(outcome: DeliveryOutcome): void {
    this.outcome = outcome
  }

  private release(id: number): void {
    this.live.delete(id)
  }

  private enforceCap(): void {
    while (this.live.size > this.maxLive) {
      const oldest = [...this.live.keys()][0]
      if (oldest === undefined) return
      const entry = this.live.get(oldest)
      this.release(oldest)
      try {
        entry?.notification.close()
      } catch {
        // Already gone.
      }
    }
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'unknown error'
}
