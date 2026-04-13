// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sync Client — Phase 2 Client-Side Sync
 *
 * Client-side component of the event-driven sync system. Connects to
 * the backend via WebSocket for real-time event streaming, with REST
 * fallback for catch-up sync on reconnection.
 *
 * Features:
 * - WebSocket connection with auto-reconnect
 * - Offline event queue (persisted in memory, future: localStorage)
 * - Catch-up sync on reconnection
 * - Event deduplication
 *
 * Usage:
 *   const client = new SyncClient({ apiBaseUrl, workspaceId, source: 'web' })
 *   client.onEvent((event) => { applyToStore(event) })
 *   client.connect()
 *   client.publishEvent({ type: 'PROJECT_CREATED', ... })
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type SyncEventSource = 'desktop' | 'web' | 'mobile' | 'api'

export type SyncEventType =
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_DELETED'
  | 'FOLDER_CREATED'
  | 'FOLDER_UPDATED'
  | 'FOLDER_DELETED'
  | 'CHAT_SESSION_CREATED'
  | 'CHAT_SESSION_UPDATED'
  | 'CHAT_SESSION_DELETED'
  | 'CHAT_MESSAGE_CREATED'
  | 'AGENT_CREATED'
  | 'AGENT_UPDATED'
  | 'AGENT_DELETED'

export interface SyncEvent {
  id: string
  type: SyncEventType
  entityId: string
  payload: Record<string, unknown>
  timestamp: number
  serverTimestamp?: number
  source: SyncEventSource
  version: number
  workspaceId: string
  instanceId?: string
  userId?: string
  /** ACK status: pending until server confirms receipt */
  status?: 'pending' | 'acknowledged' | 'failed'
}

export interface SyncClientConfig {
  /** API base URL (e.g. "https://studio.shogo.ai" or "" for same-origin) */
  apiBaseUrl: string
  /** Workspace to sync */
  workspaceId: string
  /** This client's source identifier */
  source: SyncEventSource
  /** User ID — used for subscription scoping (prevents cross-user leakage) */
  userId?: string
  /** Instance ID (for desktop clients) */
  instanceId?: string
  /** Fetch credentials mode */
  credentials?: RequestCredentials
  /** Custom fetch (e.g. for auth cookie injection) */
  fetch?: typeof globalThis.fetch
  /** Max reconnect attempts before giving up (0 = infinite) */
  maxReconnectAttempts?: number
  /** Base delay for reconnect backoff (ms) */
  reconnectBaseDelayMs?: number
  /** Timeout (ms) waiting for ACK before retrying an event (default 5000) */
  ackTimeoutMs?: number
  /** Max retries for un-ACK'd events (default 3) */
  maxEventRetries?: number
}

export type SyncEventHandler = (event: SyncEvent) => void
export type SyncStatusHandler = (status: SyncConnectionStatus) => void

export type SyncConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

// ─── Sync Client ────────────────────────────────────────────────────────────

/** Pending ACK tracker for a published event */
interface PendingAck {
  event: SyncEvent
  timer: ReturnType<typeof setTimeout>
  retries: number
}

export class SyncClient {
  private config: Required<
    Pick<SyncClientConfig, 'apiBaseUrl' | 'workspaceId' | 'source'>
  > & SyncClientConfig
  private ws: WebSocket | null = null
  private eventHandlers: SyncEventHandler[] = []
  private statusHandlers: SyncStatusHandler[] = []
  private offlineQueue: SyncEvent[] = []
  private seenEventIds = new Set<string>()
  private lastSyncTimestamp = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private status: SyncConnectionStatus = 'disconnected'
  private stopped = false
  private clientId: string
  /** Events waiting for server ACK — keyed by event ID */
  private pendingAcks = new Map<string, PendingAck>()

  constructor(config: SyncClientConfig) {
    this.config = {
      maxReconnectAttempts: 0,
      reconnectBaseDelayMs: 1000,
      ackTimeoutMs: 5000,
      maxEventRetries: 3,
      ...config,
    }
    this.clientId = `${config.source}_${crypto.randomUUID().slice(0, 8)}`
  }

  // ─── Connection ───────────────────────────────────────────────────

  /**
   * Connect to the sync WebSocket.
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.stopped = false
    this.setStatus('connecting')

    const wsBase = this.config.apiBaseUrl.replace(/^http/, 'ws')
    const params = new URLSearchParams({
      workspaceId: this.config.workspaceId,
      source: this.config.source,
      clientId: this.clientId,
    })
    if (this.config.userId) {
      params.set('userId', this.config.userId)
    }
    if (this.config.instanceId) {
      params.set('instanceId', this.config.instanceId)
    }
    if (this.lastSyncTimestamp > 0) {
      params.set('since', String(this.lastSyncTimestamp))
    }

    const url = `${wsBase}/ws/sync?${params.toString()}`

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error('[SyncClient] WebSocket creation failed:', (err as Error).message)
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[SyncClient] Connected to sync WebSocket')
      this.reconnectAttempt = 0
      this.setStatus('connected')
      this.flushOfflineQueue()
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        if (msg.type === 'sync-event') {
          const syncEvent = msg.event as SyncEvent
          this.handleIncomingEvent(syncEvent)
        } else if (msg.type === 'catch-up') {
          // Batch of catch-up events
          const events = msg.events as SyncEvent[]
          for (const e of events) {
            this.handleIncomingEvent(e)
          }
        } else if (msg.type === 'ack') {
          // Server acknowledged our event
          this.handleAck(msg.eventId as string, msg.status as 'acknowledged' | 'failed')
        } else if (msg.type === 'pong') {
          // Heartbeat response, ignore
        }
      } catch {
        // Ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      console.log('[SyncClient] WebSocket closed')
      this.ws = null
      if (!this.stopped) {
        this.setStatus('reconnecting')
        this.scheduleReconnect()
      } else {
        this.setStatus('disconnected')
      }
    }

    this.ws.onerror = () => {
      console.error('[SyncClient] WebSocket error')
      this.setStatus('error')
    }
  }

  /**
   * Disconnect and stop reconnection attempts.
   */
  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Move all pending ACKs back to offline queue
    for (const [id, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      this.offlineQueue.push(pending.event)
    }
    this.pendingAcks.clear()
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  // ─── Event Publishing ─────────────────────────────────────────────

  /**
   * Publish a sync event. If offline, queues it for later delivery.
   *
   * IMPORTANT: The caller MUST have already persisted the mutation
   * locally before calling this.  publishEvent() only distributes
   * the notification — it is NOT the write path.
   */
  publishEvent(event: Omit<SyncEvent, 'id' | 'timestamp' | 'source' | 'workspaceId'>): void {
    const fullEvent: SyncEvent = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: this.config.source,
      workspaceId: this.config.workspaceId,
      instanceId: this.config.instanceId,
      userId: this.config.userId,
      status: 'pending',
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWithAck(fullEvent)
    } else {
      // Queue for later delivery
      this.offlineQueue.push(fullEvent)
      console.log(
        `[SyncClient] Event queued (offline): ${fullEvent.type} ${fullEvent.entityId} (queue size: ${this.offlineQueue.length})`,
      )
    }

    // Mark as seen so we don’t process our own event when it echoes back
    this.seenEventIds.add(fullEvent.id)
  }

  // ─── Event Subscription ───────────────────────────────────────────

  /**
   * Subscribe to incoming sync events.
   */
  onEvent(handler: SyncEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * Subscribe to connection status changes.
   */
  onStatus(handler: SyncStatusHandler): () => void {
    this.statusHandlers.push(handler)
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler)
    }
  }

  // ─── REST Catch-Up ────────────────────────────────────────────────

  /**
   * Perform catch-up sync via REST (fallback when WebSocket is unavailable).
   */
  async catchUp(): Promise<void> {
    const fetchFn = this.config.fetch ?? fetch
    const url = `${this.config.apiBaseUrl}/api/sync?workspaceId=${encodeURIComponent(this.config.workspaceId)}&since=${this.lastSyncTimestamp}`

    try {
      const res = await fetchFn(url, {
        credentials: this.config.credentials,
      })
      if (!res.ok) return

      const data = await res.json()
      if (data.ok && data.events) {
        for (const event of data.events) {
          this.handleIncomingEvent(event)
        }
        if (data.cursor) {
          this.lastSyncTimestamp = data.cursor
        }
      }
    } catch (err) {
      console.warn('[SyncClient] Catch-up sync failed:', (err as Error).message)
    }
  }

  // ─── Status ───────────────────────────────────────────────────────

  getStatus(): SyncConnectionStatus {
    return this.status
  }

  getOfflineQueueSize(): number {
    return this.offlineQueue.length
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private handleIncomingEvent(event: SyncEvent): void {
    // Dedup
    if (this.seenEventIds.has(event.id)) return
    this.seenEventIds.add(event.id)

    // Update sync cursor
    const ts = event.serverTimestamp ?? event.timestamp
    if (ts > this.lastSyncTimestamp) {
      this.lastSyncTimestamp = ts
    }

    // Trim seen IDs set to prevent unbounded growth
    if (this.seenEventIds.size > 20_000) {
      const arr = Array.from(this.seenEventIds)
      this.seenEventIds = new Set(arr.slice(-10_000))
    }

    // Notify handlers
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (err) {
        console.error('[SyncClient] Event handler error:', (err as Error).message)
      }
    }
  }

  // ─── ACK system ─────────────────────────────────────────────────────

  /**
   * Send an event and register an ACK timer. If no ACK arrives within
   * the timeout, retry up to maxEventRetries times, then move to the
   * offline queue as a last resort.
   */
  private sendWithAck(event: SyncEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.offlineQueue.push(event)
      return
    }

    const ackTimeout = this.config.ackTimeoutMs ?? 5000
    const maxRetries = this.config.maxEventRetries ?? 3

    const timer = setTimeout(() => {
      const pending = this.pendingAcks.get(event.id)
      if (!pending) return

      if (pending.retries < maxRetries) {
        // Retry
        pending.retries++
        console.warn(
          `[SyncClient] ACK timeout for ${event.id}, retry ${pending.retries}/${maxRetries}`,
        )
        pending.timer = setTimeout(() => {
          this.handleAck(event.id, 'failed')
        }, ackTimeout)
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'sync-event', event }))
        }
      } else {
        // Max retries exhausted — move to offline queue
        console.error(
          `[SyncClient] ACK failed after ${maxRetries} retries: ${event.id}`,
        )
        this.pendingAcks.delete(event.id)
        this.offlineQueue.push({ ...event, status: 'failed' })
      }
    }, ackTimeout)

    this.pendingAcks.set(event.id, { event, timer, retries: 0 })
    this.ws.send(JSON.stringify({ type: 'sync-event', event }))
  }

  /**
   * Handle an ACK (or failure) from the server.
   */
  private handleAck(eventId: string, status: 'acknowledged' | 'failed'): void {
    const pending = this.pendingAcks.get(eventId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingAcks.delete(eventId)

    if (status === 'failed') {
      // Move to offline queue for retry on next connect
      this.offlineQueue.push({ ...pending.event, status: 'failed' })
    }
  }

  private flushOfflineQueue(): void {
    if (this.offlineQueue.length === 0) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    console.log(`[SyncClient] Flushing ${this.offlineQueue.length} queued events`)
    const queue = [...this.offlineQueue]
    this.offlineQueue = []
    for (const event of queue) {
      this.sendWithAck(event)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const maxAttempts = this.config.maxReconnectAttempts ?? 0
    const baseDelay = this.config.reconnectBaseDelayMs ?? 1000

    if (maxAttempts > 0 && this.reconnectAttempt >= maxAttempts) {
      console.error('[SyncClient] Max reconnect attempts reached')
      this.setStatus('error')
      return
    }

    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempt),
      60_000,
    )
    const jitter = delay * 0.2 * Math.random()

    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay + jitter)
  }

  private setStatus(status: SyncConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of this.statusHandlers) {
      try {
        handler(status)
      } catch {
        // Ignore handler errors
      }
    }
  }
}
