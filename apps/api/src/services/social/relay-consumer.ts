// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop end of relayed Zernio events.
 *
 * The cloud verifies a webhook, routes it to the local scope its `externalId`
 * names, and writes the delivery down before answering the provider. This is
 * the other half: poll that scope, apply each delivery in this machine's own
 * DB through the same `applySocialEvent` the cloud uses (idempotent on
 * `zernio:<event id>`), then ack it so it is not delivered again.
 *
 * Polling is what makes AC7 true across an offline desktop, a restart, or a
 * second replica — a live broadcast alone cannot.
 */

import { LOCAL_SCOPE_HEADER, resolveSocialClientConfig, type SocialClientConfig } from './client'
import { MAX_ATTEMPTS } from './relay-events.service'
import {
  applySocialEvent,
  type ApplySocialEventInput,
  type ApplySocialEventResult,
} from './webhooks'

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 5_000

export interface RelayedEventDelivery {
  id: string
  dedupeKey: string
  workspaceId: string
  localWorkspaceId: string
  externalId: string
  eventId: string
  type: string
  account?: { zernioAccountId: string; platform: string; username: string } | null
  detail?: unknown
  payload?: unknown
  occurredAt?: string
}

export interface RelayConsumerDeps {
  fetchImpl?: typeof fetch
  resolveConfig?: () => SocialClientConfig
  apply?: (input: ApplySocialEventInput) => Promise<ApplySocialEventResult>
  /** The local-only workspaces of this machine; one poll per scope. */
  localScopes?: () => Promise<string[]>
}

export interface RelayDrainResult {
  fetched: number
  applied: number
  acked: number
}

function headers(config: SocialClientConfig, localScope?: string): Record<string, string> {
  const base: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/json',
  }
  if (localScope) base[LOCAL_SCOPE_HEADER] = localScope
  return base
}

/**
 * The scopes this machine may poll: its own workspaces, minus the cloud ones it
 * is only a client of. Without this the relay would hand over a sibling
 * machine's local deliveries — same tenant, different database.
 */
async function localScopes(): Promise<string[]> {
  const { listCloudWorkspaces } = await import('../cloud-workspaces')
  const cloud = await listCloudWorkspaces().catch(() => ({ workspaces: [] as { id: string }[] }))
  const cloudIds = new Set((cloud.workspaces ?? []).map((workspace) => workspace.id))
  const rows = await (await import('../../lib/prisma')).prisma.workspace.findMany({ select: { id: true } })
  return rows.map((row) => row.id).filter((id) => !cloudIds.has(id))
}

/**
 * One poll. Never throws for a provider/cloud problem — the next tick retries,
 * and a desktop that lost its network must not take the worker down with it.
 * Returns what it did, so a test can assert exactly-once rather than "no error".
 */
export async function drainRelayedEvents(deps: RelayConsumerDeps = {}): Promise<RelayDrainResult> {
  const empty: RelayDrainResult = { fetched: 0, applied: 0, acked: 0 }

  let config: SocialClientConfig
  try {
    config = (deps.resolveConfig ?? (() => resolveSocialClientConfig()))()
  } catch {
    // Cloud mode (nothing to poll) or a desktop with no Shogo key yet.
    return empty
  }
  if (config.mode !== 'relay') return empty
  if (!config.apiKey) {
    // The key may live only in `localConfig`; without one there is nothing to
    // poll with and the next tick retries.
    const { relayCredential } = await import('./client')
    const apiKey = await relayCredential()
    if (!apiKey) return empty
    config = { ...config, apiKey }
  }

  const scopes = await (deps.localScopes ?? localScopes)().catch(() => [] as string[])
  if (scopes.length === 0) return empty

  const fetchImpl = deps.fetchImpl ?? fetch
  const apply = deps.apply ?? applySocialEvent

  const events: RelayedEventDelivery[] = []
  for (const scope of scopes) {
    try {
      const res = await fetchImpl(`${config.baseUrl}/events`, {
        method: 'GET',
        headers: headers(config, scope),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) continue
      const body = (await res.json()) as { events?: RelayedEventDelivery[] }
      if (Array.isArray(body?.events)) events.push(...body.events)
    } catch {
      // One unreachable scope must not stop the others.
    }
  }
  if (events.length === 0) return empty

  const appliedIds: string[] = []
  const failed: { id: string; error: string }[] = []
  let applied = 0
  for (const event of events) {
    // A delivery names the local workspace it belongs to; that id *is* this
    // database's workspace id, which is what the event outbox is scoped by.
    const workspaceId = event.localWorkspaceId || event.workspaceId
    if (!workspaceId || !event.eventId || !event.type) {
      // Not something we can ever apply, so report it rather than retry it
      // silently — the cloud dead-letters it after the attempt cap.
      failed.push({ id: event.id, error: 'delivery is missing workspaceId, eventId or type' })
      continue
    }
    try {
      const result = await apply({
        workspaceId,
        externalId: event.externalId,
        localWorkspaceId: event.localWorkspaceId,
        eventId: event.eventId,
        type: event.type,
        account: event.account ?? null,
        detail: event.detail ?? null,
        payload: event.payload ?? null,
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : undefined,
      })
      // `apply` answers with a status so a rejected payload is not mistaken for
      // a delivered one: acking it would drop the event for good.
      if (result.status >= 200 && result.status < 300) {
        appliedIds.push(event.id)
        applied++
      } else {
        failed.push({ id: event.id, error: readError(result.body) ?? `apply answered ${result.status}` })
      }
    } catch (err) {
      // Leave it unacked: the next tick retries, and the outbox dedupe key
      // means a partial success still lands as one event.
      failed.push({ id: event.id, error: err instanceof Error ? err.message : String(err) })
      console.warn('[Social] relayed event not applied:', err instanceof Error ? err.message : err)
    }
  }

  let acked = 0
  if (appliedIds.length > 0 || failed.length > 0) {
    try {
      const res = await fetchImpl(`${config.baseUrl}/events/ack`, {
        method: 'POST',
        headers: { ...headers(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: appliedIds, failed }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { acked?: number; deadLettered?: string[] }
        acked = typeof body?.acked === 'number' ? body.acked : 0
        if (Array.isArray(body?.deadLettered) && body.deadLettered.length > 0) {
          console.error(
            `[Social] ${body.deadLettered.length} relayed delivery(s) dead-lettered after ${MAX_ATTEMPTS} attempts:`,
            body.deadLettered.join(', '),
          )
        }
      }
    } catch {
      // Unacked rows are redelivered and deduped on `zernio:<event id>`.
    }
  }

  return { fetched: events.length, applied, acked }
}

function readError(body: unknown): string | null {
  const record = body && typeof body === 'object' ? (body as any) : null
  const message = record?.error?.message ?? record?.error
  return typeof message === 'string' && message ? message : null
}

let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

/** Poll in the background. Idempotent; a tick never overlaps itself. */
export function startSocialRelayConsumer(intervalMs?: number): void {
  if (timer) return
  const configured = Number(process.env.SOCIAL_RELAY_POLL_MS ?? intervalMs ?? DEFAULT_POLL_MS)
  const period = Number.isFinite(configured) ? Math.max(configured, MIN_POLL_MS) : DEFAULT_POLL_MS

  const tick = () => {
    if (inFlight) return
    inFlight = true
    void drainRelayedEvents()
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  timer = setInterval(tick, period)
  // Do not hold the process open, and do not wait a full period for the first
  // delivery a desktop missed while it was closed.
  ;(timer as any)?.unref?.()
  tick()
}

export function stopSocialRelayConsumer(): void {
  if (timer) clearInterval(timer)
  timer = null
}
