// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sync Engine — Phase 2 Event-Driven Synchronization
 *
 * CRITICAL DESIGN RULE:
 *   The SyncEngine is an **event distributor**, NOT the database owner.
 *   Every client (desktop, web) persists to its OWN local store first,
 *   THEN emits an event.  The engine relays that event to other clients.
 *
 * Flow:
 *   Desktop writes to local DB → emits event → SyncEngine → broadcast → Web
 *   Web writes via tunnel/cloud → emits event → SyncEngine → broadcast → Desktop
 *
 * The engine never mutates any database.  It only:
 *   1. Deduplicates events by ID
 *   2. Assigns canonical server timestamps
 *   3. Broadcasts to scoped subscribers (workspace + userId)
 *   4. Maintains an in-memory log for catch-up sync on reconnect
 *   5. Tracks ACKs so senders know their event was received
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A sync event represents a state change originating from any client.
 * Think of these as "git commits for application state."
 */
export interface SyncEvent {
  /** Unique event ID (UUID v4) — used for deduplication */
  id: string
  /** Event type: entity + action (e.g. PROJECT_CREATED, PROJECT_UPDATED) */
  type: SyncEventType
  /** ID of the entity being affected */
  entityId: string
  /** The change payload (partial entity data for updates, full for creates) */
  payload: Record<string, unknown>
  /** Client-side timestamp (ms since epoch) — used for LWW ordering */
  timestamp: number
  /** Server-assigned timestamp (ms since epoch) — canonical for conflict resolution */
  serverTimestamp?: number
  /** Which client originated this event */
  source: SyncEventSource
  /** Monotonically increasing version for the entity (optimistic concurrency) */
  version: number
  /** Workspace ID for scoping broadcasts */
  workspaceId: string
  /** Instance ID (for desktop-originated events) */
  instanceId?: string
  /** User ID who triggered the action — REQUIRED for subscription scoping */
  userId?: string
  /** ACK status: pending until server confirms receipt */
  status?: 'pending' | 'acknowledged' | 'failed'
}

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

/**
 * Subscriber callback — receives events to apply locally.
 */
export type SyncEventHandler = (event: SyncEvent) => void

/**
 * ACK callback — sent back to the event publisher.
 */
export type AckCallback = (eventId: string, status: 'acknowledged' | 'failed', error?: string) => void

/**
 * Subscriber registration.
 *
 * Scoping: a subscriber only receives events that match ALL of:
 *   • same workspaceId
 *   • same userId (if provided — prevents cross-user leakage)
 *   • NOT from the same source+instanceId (no echo)
 */
interface Subscriber {
  clientId: string
  /** Source of this subscriber (won't receive events from same source+instanceId) */
  source: SyncEventSource
  instanceId?: string
  workspaceId: string
  /** userId for subscription scoping — only receives events from this user */
  userId?: string
  handler: SyncEventHandler
  /** Optional ACK callback so senders know their event was received */
  ackCallback?: AckCallback
  /** Last event timestamp processed by this subscriber */
  lastSeenTimestamp: number
}

/**
 * Catch-up sync request — get events since a timestamp.
 */
export interface CatchUpRequest {
  workspaceId: string
  since: number
  limit?: number
}

/**
 * Catch-up sync response.
 */
export interface CatchUpResponse {
  events: SyncEvent[]
  /** Server timestamp of the most recent event (use as `since` for next request) */
  cursor: number
  /** Whether there are more events beyond `limit` */
  hasMore: boolean
}

// ─── Conflict Resolution ────────────────────────────────────────────────────

/**
 * Last-Write-Wins conflict resolver.
 *
 * Compares server timestamps (if available) or client timestamps.
 * Returns true if the incoming event should override the existing state.
 */
export function shouldApplyEvent(
  incoming: SyncEvent,
  existingVersion: number,
  existingTimestamp: number,
): boolean {
  // Version check: only apply if incoming version is newer
  if (incoming.version <= existingVersion) {
    // Same version: fall back to timestamp comparison (LWW)
    if (incoming.version === existingVersion) {
      const incomingTs = incoming.serverTimestamp ?? incoming.timestamp
      return incomingTs > existingTimestamp
    }
    return false
  }
  return true
}

// ─── Sync Engine ────────────────────────────────────────────────────────────

/**
 * In-memory event log with subscriber management.
 *
 * In Phase 2, this would be backed by a database table (sync_events).
 * For now, we keep a bounded in-memory buffer for the event log
 * and rely on the existing DB for persistence.
 */
export class SyncEngine {
  private subscribers = new Map<string, Subscriber>()
  private eventLog: SyncEvent[] = []
  private seenEventIds = new Set<string>()
  private maxLogSize: number

  constructor(opts?: { maxLogSize?: number }) {
    this.maxLogSize = opts?.maxLogSize ?? 10_000
  }

  // ─── Publish ────────────────────────────────────────────────────────

  /**
   * Publish a sync event to all relevant subscribers.
   *
   * - Assigns a server timestamp for canonical ordering
   * - Deduplicates by event ID
   * - Appends to the event log for catch-up sync
   * - Broadcasts to all subscribers in the same workspace
   *   (except the originating client)
   */
  /**
   * IMPORTANT: The caller MUST have already persisted the mutation to
   * its own local store before calling publish().  This engine only
   * distributes the event — it never writes to any database.
   */
  publish(event: SyncEvent, ackCb?: AckCallback): void {
    // Dedup: reject events we've already seen
    if (this.seenEventIds.has(event.id)) {
      ackCb?.(event.id, 'acknowledged') // already processed
      return
    }

    // Assign server timestamp for canonical ordering
    const enriched: SyncEvent = {
      ...event,
      serverTimestamp: Date.now(),
      status: 'acknowledged',
    }

    // Persist to event log
    this.eventLog.push(enriched)
    this.seenEventIds.add(event.id)

    // ACK the sender
    ackCb?.(event.id, 'acknowledged')

    // Trim log if it exceeds max size (keep newest events)
    if (this.eventLog.length > this.maxLogSize) {
      const trimmed = this.eventLog.slice(-Math.floor(this.maxLogSize * 0.8))
      const removedIds = this.eventLog
        .slice(0, this.eventLog.length - trimmed.length)
        .map((e) => e.id)
      for (const id of removedIds) {
        this.seenEventIds.delete(id)
      }
      this.eventLog = trimmed
    }

    // Broadcast to relevant, scoped subscribers
    for (const [, sub] of this.subscribers) {
      // —— Workspace scoping (mandatory) ——
      if (sub.workspaceId !== enriched.workspaceId) continue

      // —— User scoping (when subscriber provides userId) ——
      // This prevents User A from seeing User B's events.
      if (sub.userId && enriched.userId && sub.userId !== enriched.userId) continue

      // —— No echo back to the same source+instance ——
      if (
        sub.source === enriched.source &&
        sub.instanceId === enriched.instanceId
      ) {
        continue
      }

      try {
        sub.handler(enriched)
        sub.lastSeenTimestamp = enriched.serverTimestamp!
      } catch (err) {
        console.error(
          `[SyncEngine] Error in subscriber ${sub.clientId}:`,
          (err as Error).message,
        )
      }
    }
  }

  // ─── Subscribe / Unsubscribe ────────────────────────────────────────

  /**
   * Register a subscriber to receive sync events.
   */
  /**
   * @param userId  When provided, this subscriber only receives events
   *                from this user.  Pass undefined for admin/system
   *                subscriptions that should see all events.
   */
  subscribe(
    clientId: string,
    workspaceId: string,
    source: SyncEventSource,
    handler: SyncEventHandler,
    instanceId?: string,
    userId?: string,
    ackCallback?: AckCallback,
  ): () => void {
    this.subscribers.set(clientId, {
      clientId,
      source,
      instanceId,
      workspaceId,
      userId,
      handler,
      ackCallback,
      lastSeenTimestamp: Date.now(),
    })

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(clientId)
    }
  }

  /**
   * Unsubscribe a client.
   */
  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId)
  }

  // ─── Catch-Up Sync ─────────────────────────────────────────────────

  /**
   * Replay events since a given timestamp for catch-up sync.
   * Used when a client reconnects after being offline.
   */
  replayEvents(request: CatchUpRequest): CatchUpResponse {
    const limit = request.limit ?? 500

    const events = this.eventLog.filter(
      (e) =>
        e.workspaceId === request.workspaceId &&
        (e.serverTimestamp ?? e.timestamp) > request.since,
    )

    const page = events.slice(0, limit)
    const cursor =
      page.length > 0
        ? (page[page.length - 1].serverTimestamp ?? page[page.length - 1].timestamp)
        : request.since

    return {
      events: page,
      cursor,
      hasMore: events.length > limit,
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────────

  /**
   * Get the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * Get the number of events in the log.
   */
  get eventCount(): number {
    return this.eventLog.length
  }

  /**
   * Clear all state (for testing).
   */
  reset(): void {
    this.subscribers.clear()
    this.eventLog = []
    this.seenEventIds.clear()
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _engine: SyncEngine | null = null

/**
 * Get the global SyncEngine instance.
 */
export function getSyncEngine(): SyncEngine {
  if (!_engine) {
    _engine = new SyncEngine()
  }
  return _engine
}

/**
 * Reset the global SyncEngine (for testing).
 */
export function resetSyncEngine(): void {
  _engine?.reset()
  _engine = null
}

// ─── Helper: Create SyncEvent ───────────────────────────────────────────────

/**
 * Convenience factory for creating properly-shaped sync events.
 */
export function createSyncEvent(
  type: SyncEventType,
  entityId: string,
  payload: Record<string, unknown>,
  opts: {
    source: SyncEventSource
    workspaceId: string
    version?: number
    instanceId?: string
    userId?: string
  },
): SyncEvent {
  return {
    id: crypto.randomUUID(),
    type,
    entityId,
    payload,
    timestamp: Date.now(),
    version: opts.version ?? 1,
    source: opts.source,
    workspaceId: opts.workspaceId,
    instanceId: opts.instanceId,
    userId: opts.userId,
  }
}
