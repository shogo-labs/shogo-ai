// SPDX-License-Identifier: AGPL-3.0-or-later

import { prisma } from './prisma'

export type HistoryKind = 'chat' | 'plan' | 'all'

export interface HistorySearchOptions {
  workspaceId: string
  userId?: string | null
  query?: string
  kind?: HistoryKind
  limit?: number
  excludeSessionId?: string
}

export interface HistorySearchResult {
  kind: 'chat' | 'plan'
  id: string
  title: string
  snippet: string
  score: number
  projectId?: string
  projectName?: string
  filename?: string
  overview?: string
  status?: string
  createdAt: string
  lastActivityAt: string
}

const limitOf = (value?: number) => Math.max(1, Math.min(50, Math.floor(Number.isFinite(value) ? value! : 8)))
const termsOf = (query = '') => query.toLowerCase().split(/\s+/).map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean).slice(0, 12)
const textOf = (message: any) => typeof message?.content === 'string' ? message.content : ''
const titleOf = (session: any) => session.name?.trim() || session.inferredName?.trim() || textOf(session.messages?.find((message: any) => message.role === 'user')).slice(0, 100) || `Chat ${session.id.slice(0, 8)}`
const snippetOf = (text: string, terms: string[]) => {
  const clean = text.replace(/\s+/g, ' ').trim()
  const offset = terms.reduce((found, term) => {
    const index = clean.toLowerCase().indexOf(term)
    return index >= 0 && (found < 0 || index < found) ? index : found
  }, -1)
  const start = offset < 0 ? 0 : Math.max(0, offset - 100)
  return `${start ? '…' : ''}${clean.slice(start, start + 300)}${start + 300 < clean.length ? '…' : ''}`
}
const matches = (values: unknown[], terms: string[]) => {
  const text = values.filter((value): value is string => typeof value === 'string').join('\n').toLowerCase()
  const count = terms.filter((term) => text.includes(term)).length
  return count ? count / Math.max(1, terms.length) : terms.length ? 0 : 0.1
}

async function accessible(workspaceId: string, userId?: string | null): Promise<boolean> {
  if (!userId) return true
  return Boolean(await (prisma as any).member.findFirst({ where: { workspaceId, userId }, select: { id: true } }))
}

async function projectIds(workspaceId: string): Promise<string[]> {
  const projects = await (prisma as any).project.findMany({ where: { workspaceId }, select: { id: true } })
  return projects.map((project: any) => project.id)
}

export async function searchWorkspaceHistory(options: HistorySearchOptions): Promise<{ results: HistorySearchResult[]; count: number }> {
  if (!(await accessible(options.workspaceId, options.userId))) return { results: [], count: 0 }
  const limit = limitOf(options.limit)
  const terms = termsOf(options.query)
  const ids = await projectIds(options.workspaceId)
  const results: HistorySearchResult[] = []
  if (!options.kind || options.kind === 'all' || options.kind === 'chat') {
    const sessions = await (prisma as any).chatSession.findMany({
      where: {
        OR: [
          { contextType: 'workspace', workspaceId: options.workspaceId },
          ...(ids.length ? [{ contextType: 'project', contextId: { in: ids } }] : []),
        ],
        ...(options.excludeSessionId ? { id: { not: options.excludeSessionId } } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        messages: { where: { role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' }, take: 500, select: { role: true, content: true, createdAt: true } },
      },
      orderBy: { lastActiveAt: 'desc' },
      take: 500,
    })
    for (const session of sessions) {
      const title = titleOf(session)
      const score = matches([title, ...session.messages.map(textOf)], terms)
      if (!score) continue
      const message = [...session.messages].reverse().find((item: any) => textOf(item)) || { content: title }
      results.push({
        kind: 'chat', id: session.id, title, snippet: snippetOf(textOf(message), terms), score,
        ...(session.project ? { projectId: session.project.id, projectName: session.project.name } : {}),
        createdAt: new Date(session.createdAt).toISOString(),
        lastActivityAt: new Date(session.lastActiveAt || session.updatedAt).toISOString(),
      })
    }
  }
  if (!options.kind || options.kind === 'all' || options.kind === 'plan') {
    const plans = await (prisma as any).plan.findMany({
      where: { OR: [{ workspaceId: options.workspaceId }, ...(ids.length ? [{ projectId: { in: ids } }] : [])] },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    })
    for (const plan of plans) {
      const score = matches([plan.name, plan.overview, plan.content], terms)
      if (!score) continue
      results.push({
        kind: 'plan', id: plan.id, title: plan.name || plan.filename,
        filename: plan.filename, overview: plan.overview, status: plan.status,
        snippet: snippetOf(plan.overview || plan.content || plan.name, terms), score,
        ...(plan.project ? { projectId: plan.project.id, projectName: plan.project.name } : {}),
        createdAt: new Date(plan.createdAt).toISOString(), lastActivityAt: new Date(plan.updatedAt).toISOString(),
      })
    }
  }
  results.sort((a, b) => b.score - a.score || b.lastActivityAt.localeCompare(a.lastActivityAt))
  return { results: results.slice(0, limit), count: Math.min(results.length, limit) }
}

export async function renderWorkspaceTranscript(
  sessionId: string,
  options: { workspaceId: string; userId?: string | null; from?: number; limit?: number; maxBytes?: number },
) {
  const result = await searchWorkspaceSession(sessionId, options)
  if (!result) return null
  const messages: Array<{ role: string; text: string; createdAt: string }> = []
  const maxBytes = Math.min(256 * 1024, Math.max(1024, options.maxBytes ?? 64 * 1024))
  let used = 0
  for (const message of result.messages.slice(options.from ?? 0, (options.from ?? 0) + Math.min(options.limit ?? 100, 200))) {
    const text = textOf(message)
    if (!text) continue
    const clipped = text.slice(0, Math.max(0, maxBytes - used))
    messages.push({ role: message.role, text: clipped, createdAt: new Date(message.createdAt).toISOString() })
    used += clipped.length
    if (clipped.length < text.length) break
  }
  return {
    sessionId, title: titleOf(result), ...(result.project ? { projectId: result.project.id, projectName: result.project.name } : {}),
    messages, truncated: used >= maxBytes || messages.length < result.messages.length,
  }
}

async function searchWorkspaceSession(sessionId: string, options: { workspaceId: string; userId?: string | null }) {
  if (!(await accessible(options.workspaceId, options.userId))) return null
  const ids = await projectIds(options.workspaceId)
  return (prisma as any).chatSession.findFirst({
    where: {
      id: sessionId,
      OR: [
        { contextType: 'workspace', workspaceId: options.workspaceId },
        ...(ids.length ? [{ contextType: 'project', contextId: { in: ids } }] : []),
      ],
    },
    include: { project: { select: { id: true, name: true } }, messages: { where: { role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' } } },
  })
}

export async function readWorkspacePlan(planId: string, options: { workspaceId: string; userId?: string | null }) {
  if (!(await accessible(options.workspaceId, options.userId))) return null
  const ids = await projectIds(options.workspaceId)
  const plan = await (prisma as any).plan.findFirst({
    where: { id: planId, OR: [{ workspaceId: options.workspaceId }, ...(ids.length ? [{ projectId: { in: ids } }] : [])] },
    include: { project: { select: { id: true, name: true } } },
  })
  return plan ? { ...plan, createdAt: new Date(plan.createdAt).toISOString(), updatedAt: new Date(plan.updatedAt).toISOString() } : null
}
