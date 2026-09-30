// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who can be tagged in a workspace's team chat: people, agents and groups,
 * each with the mention token that tags them. Backs the agents' directory
 * tool and plain `@Name` resolution in agent posts.
 */

import { prisma } from '../lib/prisma'
import {
  agentMentionToken,
  buildMentionLookup,
  groupMentionToken,
  resolveFriendlyMentionsWith,
  userMentionToken,
  type MentionDirectoryEntry,
} from './conversation-mentions'

const db = prisma as any

export interface TeamDirectory {
  people: Array<{ userId: string; name: string | null; email: string; tag: string }>
  agents: Array<{ projectId: string | null; name: string; role: string | null; tag: string }>
  groups: Array<{ groupId: string; handle: string; name: string; tag: string }>
}

export async function loadTeamDirectory(workspaceId: string): Promise<TeamDirectory> {
  const [members, projects, groups, profile] = await Promise.all([
    db.member.findMany({
      where: { workspaceId },
      distinct: ['userId'],
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
    db.project.findMany({
      where: { workspaceId, status: { not: 'archived' } },
      select: { id: true, name: true, description: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.userGroup.findMany({ where: { workspaceId }, select: { id: true, handle: true, name: true } }),
    db.workspaceAgentProfile.findUnique({ where: { workspaceId }, select: { name: true } }).catch(() => null),
  ])
  return {
    people: members
      .filter((m: any) => m.user?.email)
      .map((m: any) => ({ userId: m.userId, name: m.user.name ?? null, email: m.user.email, tag: userMentionToken(m.userId) })),
    agents: [
      { projectId: null, name: profile?.name || 'Shogo', role: 'Workspace agent', tag: agentMentionToken(null) },
      ...projects.map((p: any) => ({ projectId: p.id, name: p.name, role: p.description ?? null, tag: agentMentionToken(p.id) })),
    ],
    groups: groups.map((g: any) => ({ groupId: g.id, handle: g.handle, name: g.name, tag: groupMentionToken(g.id) })),
  }
}

/** "Issue Pipeline — Analyst" also answers to "Analyst". */
function shortAgentName(name: string): string | null {
  const parts = name.split(/\s+[—–:|/-]\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : null
}

export function directoryEntries(directory: TeamDirectory): MentionDirectoryEntry[] {
  const entries: MentionDirectoryEntry[] = []
  for (const p of directory.people) {
    const first = p.name?.trim().split(/\s+/)[0]
    entries.push({ token: p.tag, names: [p.name ?? '', p.email, first && first !== p.name ? first : ''] })
  }
  for (const a of directory.agents) {
    const short = shortAgentName(a.name)
    entries.push({ token: a.tag, names: [a.name, short ?? ''] })
  }
  for (const g of directory.groups) entries.push({ token: g.tag, names: [g.handle, g.name] })
  return entries
}

/** Resolve plain `@Name`, `@email` and `@group-handle` in `text` to mention tokens. */
export async function resolveFriendlyMentions(workspaceId: string, text: string): Promise<string> {
  if (!text.includes('@')) return text
  const directory = await loadTeamDirectory(workspaceId)
  return resolveFriendlyMentionsWith(text, buildMentionLookup(directoryEntries(directory)))
}
