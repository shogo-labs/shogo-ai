// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Is anything running on this machine right now?" (SHO-181)
 *
 * The desktop asks its own local API — `GET /api/local/system/activity` — before
 * it restarts for an update or quits. That answer decides whether the user gets
 * the choice at all, so this module is deliberately dumb: one fetch, one shape,
 * and a `null` for "I could not tell", which the callers treat as nothing live
 * (an API that cannot answer has nothing running to interrupt).
 *
 * Electron-free so the gate around it can be unit-tested.
 */

export interface LiveActivity {
  /**
   * Agent runs a restart would interrupt — one per run, counted by the API.
   * A team-chat reply and the chat session it opens are the same run, and a card
   * watch is not a run at all (SHO-317).
   */
  agentRuns: number
  /**
   * Background *commands* (a shell task, a subagent) that die with the process.
   * They are not agent runs and they do not hold "Restart when idle": SHO-141
   * marks them interrupted and wakes their agent on the next boot.
   */
  backgroundCommands: number
}

export interface ActivitySession {
  id: string
  title: string | null
  workspaceId: string | null
}

export interface LiveActivityReport extends LiveActivity {
  sessions: ActivitySession[]
}

export const NO_LIVE_ACTIVITY: LiveActivity = { agentRuns: 0, backgroundCommands: 0 }

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Everything a restart interrupts, as one number.
 *
 * Deliberately `agentRuns` alone: background commands are reported next to it
 * but must not keep the machine "busy" — a `sleep 900` in a shell would hold
 * "Restart when idle" forever while interrupting no run at all.
 */
export function liveActivityTotal(activity: LiveActivity | null | undefined): number {
  if (!activity) return 0
  return toCount(activity.agentRuns)
}

/** ", and 2 background commands, which report back as interrupted" — or ''. */
function backgroundClause(count: number): string {
  if (count <= 0) return ''
  return count === 1
    ? ', and 1 background command, which reports back as interrupted'
    : `, and ${count} background commands, which report back as interrupted`
}

/** "3 agent runs are working" / "1 agent run is working". */
export function describeLiveActivity(activity: LiveActivity | null | undefined): string {
  const total = liveActivityTotal(activity)
  const base = total === 1 ? '1 agent run is working' : `${total} agent runs are working`
  if (total === 0) {
    const commands = toCount(activity?.backgroundCommands)
    return commands === 1
      ? '1 background command is running'
      : `${commands} background commands are running`
  }
  return base + backgroundClause(toCount(activity?.backgroundCommands))
}

/**
 * Read the counts from the running API. Never throws: a stopped, slow or
 * unreachable API answers "nothing live", which is true when it is stopped and
 * the safe default when it is merely slow — blocking an update forever is worse
 * than the bug this fixes.
 */
export async function fetchLiveActivity(
  apiUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LiveActivityReport | null> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await doFetch(`${apiUrl.replace(/\/$/, '')}/api/local/system/activity`, {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || body.ok === false) return null
    const sessions = Array.isArray(body.sessions)
      ? (body.sessions as Array<Record<string, unknown>>).map((session) => ({
          id: String(session.id ?? ''),
          title: typeof session.title === 'string' ? session.title : null,
          workspaceId: typeof session.workspaceId === 'string' ? session.workspaceId : null,
        }))
      : []
    return {
      // `liveTurns` is the pre-SHO-317 name: an API old enough to answer without
      // `agentRuns` still has the live-turn count, and that is the honest number.
      agentRuns: toCount(body.agentRuns ?? body.liveTurns),
      backgroundCommands: toCount(body.backgroundCommands),
      sessions,
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Turn the local API's drain hold on or off. True when the API accepted it. */
export async function setApiDrain(
  apiUrl: string,
  on: boolean,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; reason?: string } = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000) : null
  try {
    const res = await doFetch(`${apiUrl.replace(/\/$/, '')}/api/local/system/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on, reason: options.reason ?? 'desktop-restart' }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    return res.ok
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
