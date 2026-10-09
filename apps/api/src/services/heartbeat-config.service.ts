// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Heartbeat Config Service
 *
 * The single writer for the heartbeat fields of `AgentConfig`
 * (`heartbeatEnabled`, `heartbeatInterval`, `nextHeartbeatAt`, quiet hours).
 *
 * Heartbeat scheduling used to be re-implemented at every write site (UI
 * PATCH, runtime sync, internal config, admin override, project lifecycle,
 * import, marketplace install). Two of those forgot to set `nextHeartbeatAt`
 * — which the scheduler needs (`nextHeartbeatAt <= NOW()`) — and they
 * disagreed on jitter and the paid-plan gate. Everything now goes through
 * here; `scripts/check-heartbeat-config-writes.ts` fails CI if an
 * `agentConfig` write touching these fields appears anywhere else.
 *
 * Uses only plain `findUnique` / `update` / `upsert` so it works unchanged on
 * both the Postgres (cloud) and SQLite (desktop) Prisma clients.
 */

import { prisma } from '../lib/prisma'
import { computeJitter } from '../lib/base-heartbeat-scheduler'

export const MIN_HEARTBEAT_INTERVAL_SECONDS = 60
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1800

export type HeartbeatConfigErrorCode = 'paywall' | 'invalid_interval' | 'not_found'

export const HEARTBEAT_PAYWALL_MESSAGE =
  'Heartbeats require a paid plan. Please upgrade to enable scheduled heartbeats.'

export class HeartbeatConfigError extends Error {
  constructor(public code: HeartbeatConfigErrorCode, message: string) {
    super(message)
    this.name = 'HeartbeatConfigError'
  }
}

/**
 * When the next heartbeat should fire: `now + interval + jitter`, or `null`
 * when heartbeats are disabled.
 */
export function computeNextHeartbeatAt(
  enabled: boolean,
  intervalSeconds: number,
  now: number = Date.now(),
): Date | null {
  if (!enabled) return null
  return new Date(now + intervalSeconds * 1000 + computeJitter(intervalSeconds))
}

export interface HeartbeatConfigPatch {
  heartbeatEnabled?: boolean
  heartbeatInterval?: number
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  quietHoursTimezone?: string | null
}

export interface UpdateHeartbeatConfigOptions {
  /** Require a paid plan when the resulting config is enabled. Default true. */
  enforcePaywall?: boolean
  /** Create the `AgentConfig` row when missing instead of throwing `not_found`. */
  createIfMissing?: boolean
  /** Non-heartbeat columns for a row created by `createIfMissing` (model, channels, ...). */
  createDefaults?: Record<string, unknown>
  /**
   * Reschedule `nextHeartbeatAt` on every call while enabled. Default: only
   * when heartbeats are switched on, the interval changes, or the row has no
   * next-run time yet.
   */
  alwaysReschedule?: boolean
  /** Throw `invalid_interval` for an interval below the minimum instead of ignoring it. */
  strictInterval?: boolean
  /** Fire `first_heartbeat_scheduled` when heartbeats are switched on. Default true. */
  trackFirstEnable?: boolean
}

export interface UpdateHeartbeatConfigResult {
  /** The full `AgentConfig` row after the write. */
  config: any
  /** Whether heartbeats were enabled before this write. */
  previousEnabled: boolean
}

async function assertPaidWorkspace(projectId: string): Promise<void> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })) as { workspaceId: string | null } | null
  if (!project?.workspaceId) return
  const { hasPaidSubscription } = await import('./billing-runtime')
  if (!(await hasPaidSubscription(project.workspaceId))) {
    throw new HeartbeatConfigError('paywall', HEARTBEAT_PAYWALL_MESSAGE)
  }
}

function trackFirstHeartbeat(projectId: string): void {
  prisma.project
    .findUnique({ where: { id: projectId }, select: { createdBy: true } })
    .then(async (proj: { createdBy: string | null } | null) => {
      if (!proj?.createdBy) return
      const { trackEvent } = await import('./loops.service')
      await trackEvent(proj.createdBy, 'first_heartbeat_scheduled', { project_id: projectId })
    })
    .catch(() => {})
}

/**
 * Apply a heartbeat config patch to a project's `AgentConfig`: merge with the
 * current row, validate, enforce the paid-plan gate, and compute
 * `nextHeartbeatAt`.
 */
export async function updateHeartbeatConfig(
  projectId: string,
  patch: HeartbeatConfigPatch,
  opts: UpdateHeartbeatConfigOptions = {},
): Promise<UpdateHeartbeatConfigResult> {
  const { enforcePaywall = true, trackFirstEnable = true } = opts

  let validInterval: number | undefined
  if (typeof patch.heartbeatInterval === 'number') {
    if (patch.heartbeatInterval >= MIN_HEARTBEAT_INTERVAL_SECONDS) {
      validInterval = patch.heartbeatInterval
    } else if (opts.strictInterval) {
      throw new HeartbeatConfigError(
        'invalid_interval',
        `heartbeatInterval must be at least ${MIN_HEARTBEAT_INTERVAL_SECONDS} seconds`,
      )
    }
  }

  const existing = (await prisma.agentConfig.findUnique({ where: { projectId } })) as any
  if (!existing && !opts.createIfMissing) {
    throw new HeartbeatConfigError('not_found', 'Agent config not found')
  }

  const previousEnabled = existing?.heartbeatEnabled === true
  const enabled = typeof patch.heartbeatEnabled === 'boolean' ? patch.heartbeatEnabled : previousEnabled
  const interval = validInterval ?? existing?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS

  if (enforcePaywall && enabled) await assertPaidWorkspace(projectId)

  const data: Record<string, unknown> = {}
  if (typeof patch.heartbeatEnabled === 'boolean') data.heartbeatEnabled = patch.heartbeatEnabled
  if (validInterval !== undefined) data.heartbeatInterval = validInterval
  if (patch.quietHoursStart !== undefined) data.quietHoursStart = patch.quietHoursStart || null
  if (patch.quietHoursEnd !== undefined) data.quietHoursEnd = patch.quietHoursEnd || null
  if (patch.quietHoursTimezone !== undefined) data.quietHoursTimezone = patch.quietHoursTimezone || null

  if (!enabled) {
    data.nextHeartbeatAt = null
  } else {
    const switchedOn = !previousEnabled
    const intervalChanged = existing ? interval !== existing.heartbeatInterval : true
    const missingNextRun = !existing || existing.nextHeartbeatAt == null
    if (opts.alwaysReschedule || switchedOn || intervalChanged || missingNextRun) {
      data.nextHeartbeatAt = computeNextHeartbeatAt(true, interval)
    }
  }

  let config: any
  if (existing) {
    config = await prisma.agentConfig.update({ where: { projectId }, data: data as any })
  } else {
    config = await prisma.agentConfig.create({
      data: {
        channels: [],
        ...(opts.createDefaults ?? {}),
        ...data,
        projectId,
        heartbeatEnabled: enabled,
        heartbeatInterval: interval,
      } as any,
    })
  }

  if (trackFirstEnable && enabled && !previousEnabled) trackFirstHeartbeat(projectId)

  return { config, previousEnabled }
}

/** Source fields for a brand-new `AgentConfig` (import, marketplace install, templates). */
export interface AgentConfigCreateSource {
  heartbeatEnabled?: boolean | null
  heartbeatInterval?: number | null
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  quietHoursTimezone?: string | null
  modelProvider?: string | null
  modelName?: string | null
  channels?: unknown
}

/**
 * Build `prisma.agentConfig.create` data that always carries a valid
 * `nextHeartbeatAt` when heartbeats are enabled. Quiet-hours columns are only
 * included when the source defines them (older bundles omit them).
 */
export function buildAgentConfigCreateData(
  projectId: string,
  source: AgentConfigCreateSource = {},
): Record<string, unknown> {
  const enabled = source.heartbeatEnabled === true
  const interval =
    typeof source.heartbeatInterval === 'number' && source.heartbeatInterval >= MIN_HEARTBEAT_INTERVAL_SECONDS
      ? source.heartbeatInterval
      : DEFAULT_HEARTBEAT_INTERVAL_SECONDS

  const data: Record<string, unknown> = {
    projectId,
    heartbeatEnabled: enabled,
    heartbeatInterval: interval,
    nextHeartbeatAt: computeNextHeartbeatAt(enabled, interval),
    modelProvider: source.modelProvider ?? 'anthropic',
    channels: source.channels ?? [],
  }
  if (source.modelName != null) data.modelName = source.modelName
  if (source.quietHoursStart !== undefined) data.quietHoursStart = source.quietHoursStart
  if (source.quietHoursEnd !== undefined) data.quietHoursEnd = source.quietHoursEnd
  if (source.quietHoursTimezone !== undefined) data.quietHoursTimezone = source.quietHoursTimezone
  return data
}
