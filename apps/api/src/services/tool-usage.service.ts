/**
 * Per-project tool usage (SHO-97).
 *
 * Which tools an agent actually calls is already recorded — `tool_call_logs`
 * holds every call. This ranks that history (last 30 days, recency-weighted)
 * so the agent runtime can keep each project's own most-used tool definitions
 * advertised and defer the rest. No new table, no new telemetry.
 *
 * Scope: only `contextType = 'project'` sessions count, because they are the
 * ones that carry a `contextId` to rank a project's own history by. Locally
 * that is ~85% of logged calls (39,881 of 46,936); the rest are workspace- or
 * chat-scoped (`contextId` null) and fall back to the static ranking. Widening
 * this would mix unrelated workspaces' habits into one project's keep-set.
 */

import { prisma } from '../lib/prisma'

export interface ProjectToolUsage {
  /** Tool names, most-called first. */
  tools: Array<{ name: string; calls: number }>
  /** Calls in the window. Below 50 the runtime keeps its static ranking. */
  totalCalls: number
}

const WINDOW_DAYS = 30
const RECENT_DAYS = 7
/** A tool called once a week recently should outrank one called often a month ago. */
const RECENT_WEIGHT = 2
const TOP_TOOLS = 60
const CACHE_TTL_MS = 60 * 60 * 1000

const cache = new Map<string, { at: number; value: ProjectToolUsage }>()
const inFlight = new Map<string, Promise<ProjectToolUsage>>()

/** Drop a project's cached ranking (used by tests and after a reset). */
export function invalidateToolUsage(projectId?: string): void {
  if (projectId) cache.delete(projectId)
  else cache.clear()
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

async function groupToolCalls(projectId: string, since: Date): Promise<Map<string, number>> {
  const rows = (await prisma.toolCallLog.groupBy({
    by: ['toolName'],
    where: {
      createdAt: { gte: since },
      chatSession: { is: { contextType: 'project', contextId: projectId } },
    },
    _count: { toolName: true },
    orderBy: { _count: { toolName: 'desc' } },
    take: TOP_TOOLS,
  })) as unknown as Array<{ toolName: string; _count: { toolName: number } }>

  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.toolName, row._count?.toolName ?? 0)
  return counts
}

/**
 * The project's most-used tools over the last 30 days, cached for an hour.
 * Never throws — a read failure just means "no learning yet".
 */
export async function readProjectToolUsage(projectId: string): Promise<ProjectToolUsage> {
  const cached = cache.get(projectId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const pending = inFlight.get(projectId)
  if (pending) return pending

  const task = (async (): Promise<ProjectToolUsage> => {
    try {
      const [all, recent] = await Promise.all([
        groupToolCalls(projectId, daysAgo(WINDOW_DAYS)),
        groupToolCalls(projectId, daysAgo(RECENT_DAYS)),
      ])
      let totalCalls = 0
      for (const count of all.values()) totalCalls += count

      const tools = [...all.entries()]
        .map(([name, calls]) => ({ name, calls, score: calls + RECENT_WEIGHT * (recent.get(name) ?? 0) }))
        .sort((a, b) => b.score - a.score || b.calls - a.calls || a.name.localeCompare(b.name))
        .map(({ name, calls }) => ({ name, calls }))

      return { tools, totalCalls }
    } catch (err: any) {
      console.warn(`[tool-usage] ranking lookup failed for ${projectId}: ${err?.message ?? err}`)
      return { tools: [], totalCalls: 0 }
    } finally {
      inFlight.delete(projectId)
    }
  })()

  inFlight.set(projectId, task)
  const value = await task
  // A failed lookup is not cached, so the next turn retries instead of limping
  // on the static ranking for an hour.
  if (value.totalCalls > 0 || value.tools.length > 0) cache.set(projectId, { at: Date.now(), value })
  return value
}
