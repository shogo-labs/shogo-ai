// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prune a closing card's `.tmp` worktrees (SHO-607 §3).
 *
 * When a card enters a `done` / `dismissed` column the agent that worked it may
 * still have a full `shogo-ai` checkout with its own `node_modules` under that
 * project's `.tmp`. This tells the project's runtime to remove it — but only
 * the runtimes that are **already running**: waking a stopped one to delete a
 * directory is worse than waiting for its own boot sweep.
 *
 * The runtime re-reads the workspace's open/closed cards before touching
 * anything, so a worktree that belongs to some other open card can never be
 * collateral of this call. Whatever it could not remove (dirty, unpushed) comes
 * back and is posted as one comment on the card, so the reason is visible where
 * the agent will look.
 *
 * Desktop only. A cloud runtime is a recycled pod and has no persistent `.tmp`;
 * its own boot sweep covers the rest.
 */

import { prisma } from '../lib/prisma'
import { fetchFromProjectRuntime } from '../lib/chat-runtime-fetch'
import { agentRefProjectId } from './work-board-defaults'
import { commentWorkItem } from './work-boards.service'

const db = prisma

const SYSTEM_ACTOR = { userId: null, agentRef: null, sessionId: null } as const
const PRUNE_TIMEOUT_MS = 60_000

interface ClosedCardRef {
  key: string
  number: number
  branch: string | null
  prs: Array<{ number: number; headRef: string | null; headSha: string | null; state?: 'open' | 'closed'; merged?: boolean }>
}

interface KeptWorktree {
  path: string
  branch: string | null
  reason: string
}

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

/** Agents that touched the card, as project ids inside this workspace. */
async function agentsThatTouched(item: any): Promise<string[]> {
  const refs = new Set<string>()
  if (typeof item.assigneeAgentRef === 'string') refs.add(item.assigneeAgentRef)
  if (item.column?.agentRef) refs.add(item.column.agentRef)

  const events = await db.workItemEvent.findMany({
    where: { workItemId: item.id },
    select: { actorAgentRef: true, eventData: true },
  })
  for (const event of events) {
    if (typeof event.actorAgentRef === 'string') refs.add(event.actorAgentRef)
    const data: Record<string, unknown> =
      event.eventData && typeof event.eventData === 'object' && !Array.isArray(event.eventData)
        ? (event.eventData as Record<string, unknown>)
        : {}
    if (typeof data.assigneeAgentRef === 'string') refs.add(data.assigneeAgentRef)
    // `moveWorkItem` records the column agent the card arrived at, so an agent
    // that only ever held it as a column is still a target.
    if (typeof data.columnAgentRef === 'string') refs.add(data.columnAgentRef)
  }

  const projectIds = [...new Set([...refs].map((ref) => agentRefProjectId(ref)).filter((id): id is string => !!id))]
  if (!projectIds.length) return []
  const projects = await db.project.findMany({
    where: { id: { in: projectIds }, workspaceId: item.workspaceId },
    select: { id: true },
  })
  return projects.map((project: any) => project.id)
}

/** Is this project's runtime already up? Never wake one just to prune. */
async function runtimeIsRunning(projectId: string): Promise<boolean> {
  try {
    const { getRuntimeManager } = await import('../lib/runtime/manager')
    return getRuntimeManager().status(projectId)?.status === 'running'
  } catch {
    return false
  }
}

async function cardRef(item: any): Promise<ClosedCardRef | null> {
  const fields = item.fields && typeof item.fields === 'object' ? item.fields : {}
  const branch = typeof fields.branch === 'string' && fields.branch.trim() ? fields.branch.trim() : null
  const links = await db.workItemLink.findMany({
    where: { workItemId: item.id, kind: 'pr' },
    select: { refId: true, metadata: true },
  })
  const prs = links
    .map((link: any) => {
      const metadata = link.metadata && typeof link.metadata === 'object' ? link.metadata : {}
      const number = Number(metadata.number ?? link.refId)
      if (!Number.isInteger(number) || number <= 0) return null
      return {
        number,
        headRef: typeof metadata.headRef === 'string' && metadata.headRef ? metadata.headRef : null,
        headSha: typeof metadata.headSha === 'string' && metadata.headSha ? metadata.headSha : null,
        state: metadata.state === 'closed' ? ('closed' as const) : ('open' as const),
        merged: metadata.merged === true,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
  if (!branch && prs.length === 0) return null
  return { key: item.key, number: item.number, branch, prs }
}

/**
 * Fire-and-forget: called by `moveWorkItem` when a card enters a closed
 * column. Never throws — a failed cleanup must not fail the move.
 */
export async function pruneTmpForClosedCard(item: any): Promise<void> {
  if (isKubernetes()) return
  try {
    const card = await cardRef(item)
    if (!card) return
    const projectIds = await agentsThatTouched(item)
    if (!projectIds.length) return

    const kept: KeptWorktree[] = []
    for (const projectId of projectIds) {
      if (!(await runtimeIsRunning(projectId))) continue
      try {
        const response = await fetchFromProjectRuntime(
          projectId,
          '/agent/tmp-hygiene/prune',
          {
            method: 'POST',
            body: JSON.stringify({ card }),
            signal: AbortSignal.timeout(PRUNE_TIMEOUT_MS),
          },
          { background: true },
        )
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        const body = await response.json().catch(() => null) as { kept?: KeptWorktree[] } | null
        for (const entry of body?.kept ?? []) {
          if (entry?.path) kept.push(entry)
        }
      } catch (err: any) {
        console.warn(`[tmp-prune] ${item.key}: ${projectId} failed: ${err?.message ?? err}`)
      }
    }

    if (kept.length) {
      const lines = kept.map((entry) => `- \`${entry.path}\` — ${entry.reason}`)
      await commentWorkItem(
        item,
        `Left ${kept.length} worktree${kept.length === 1 ? '' : 's'} in place (they hold work that is not on a remote):\n${lines.join('\n')}`,
        SYSTEM_ACTOR,
        { system: true },
      )
    }
  } catch (err: any) {
    console.warn(`[tmp-prune] ${item?.key ?? 'card'} failed: ${err?.message ?? err}`)
  }
}
