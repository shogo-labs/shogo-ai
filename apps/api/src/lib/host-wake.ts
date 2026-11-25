// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one refusal shape every "reach a paired machine" route answers with
 * (SHO-506).
 *
 * Two different things used to come back as `device_offline`: a machine whose
 * heartbeat is stale (it really is away) and a machine that is up but whose
 * tunnel did not open inside the wake window. An agent was told not to retry the
 * first, so the second read to it — and to the user — as "this Mac is off".
 *
 * `device_connecting` / `host_connecting` is retryable and carries the seconds to
 * wait, so a caller that follows it gets the machine on the next attempt.
 * `device_` is the agent-facing surface (`/devices/:id/remote-tool`, the
 * cross-workspace tool); `host_` is this API's own internal runtime URL, which no
 * client ever sees.
 */
import type { HostWakeResult } from '../routes/instances'

export type WakeRefusalCode = 'device_offline' | 'device_connecting' | 'host_offline' | 'host_connecting'

export interface WakeRefusal {
  code: WakeRefusalCode
  message: string
  instanceId: string
  /** ISO timestamp of the host's last heartbeat, when it has one. */
  lastSeenAt: string | null
  retryable: boolean
  /** Present on `*_connecting`: how long to wait before asking again. */
  retryAfterSeconds?: number
}

/** "40s ago" / "12 min ago" — the phrasing a person (or a model) can act on. */
function ageLabel(lastSeenAt: Date | null): string | null {
  if (!lastSeenAt) return null
  const age = Math.max(0, Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 1000))
  if (age < 120) return `${age}s ago`
  if (age < 5400) return `${Math.round(age / 60)} min ago`
  return `${Math.round(age / 3600)} h ago`
}

/**
 * The refusal body for a wake that did not reach `connected`.
 *
 * Returns `null` for a connected host, so a caller reads
 * `const refusal = wakeRefusal(wake, 'device'); if (refusal) return c.json({ error: refusal }, 503)`.
 */
export function wakeRefusal(
  wake: HostWakeResult,
  prefix: 'device' | 'host',
  opts: { subject?: string | null } = {},
): WakeRefusal | null {
  if (wake.state === 'connected') return null
  const subject = opts.subject || wake.name || (prefix === 'device' ? 'The machine' : 'The desktop hosting this workspace')
  const iso = wake.lastSeenAt ? new Date(wake.lastSeenAt).toISOString() : null
  if (wake.state === 'connecting') {
    const age = ageLabel(wake.lastSeenAt)
    return {
      code: prefix === 'device' ? 'device_connecting' : 'host_connecting',
      message:
        `${subject} is online${age ? ` (seen ${age})` : ''} but its connection is still opening; ` +
        `try again in ~${wake.retryAfterSeconds}s`,
      instanceId: wake.instanceId,
      lastSeenAt: iso,
      retryable: true,
      retryAfterSeconds: wake.retryAfterSeconds,
    }
  }
  return {
    code: prefix === 'device' ? 'device_offline' : 'host_offline',
    message: `${subject} is offline${iso ? ` (last seen ${iso})` : ''}`,
    instanceId: wake.instanceId,
    lastSeenAt: iso,
    // The internal runtime URL keeps its long-standing `retryable` flag (a hosted
    // workspace's client asks again on the next turn); the agent-facing surface
    // stays "do not retry", which is what its guidance says.
    retryable: prefix === 'host',
  }
}
