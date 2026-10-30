// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — what "everything in the workspace" means, once, for both kinds of
 * workspace.
 *
 * `seedWorkspace` writes the same content into any workspace through its own
 * API (projects, project and workspace chats with messages, channels with a
 * thread, a board with a card, a channel doc, a schedule and a trigger).
 * `SURFACES` lists every read a screen makes to show it, each with a projection
 * of the answer onto what a person sees. The parity suite runs the list against
 * a cloud workspace (the VM baseline) and against a paired machine's workspace
 * opened from the cloud, and compares the machine's answers with the desktop's
 * own.
 */
import type { HttpClient } from '@shogo-ai/sdk'

export interface Seeded {
  workspaceId: string
  tag: string
  projectIds: string[]
  projectNames: string[]
  projectChatIds: string[]
  workspaceChatId: string
  channelId: string
  channelName: string
  threadRootId: string
  messageTexts: string[]
  replyText: string
  boardId: string
  itemId: string
  itemTitle: string
  docTitle: string
  scheduleId: string
  scheduleName: string
  triggerId: string
  triggerName: string
}

async function post<T = any>(client: HttpClient, path: string, body: unknown, what: string): Promise<T> {
  try {
    const res: any = await client.post(path, body)
    return res.data as T
  } catch (err: any) {
    throw new Error(`seed ${what}: POST ${path} → ${err?.status} ${JSON.stringify(err?.details ?? err?.message)}`)
  }
}

async function put<T = any>(client: HttpClient, path: string, body: unknown, what: string): Promise<T> {
  try {
    const res: any = await client.request(path, { method: 'PUT', body: body as any })
    return res.data as T
  } catch (err: any) {
    throw new Error(`seed ${what}: PUT ${path} → ${err?.status} ${JSON.stringify(err?.details ?? err?.message)}`)
  }
}

/**
 * Write one workspace's worth of content through that workspace's own API.
 * `tag` makes every name unique to this workspace, so a surface that shows the
 * wrong workspace's rows cannot pass by matching names.
 */
export async function seedWorkspace(client: HttpClient, workspaceId: string, tag: string): Promise<Seeded> {
  const ws = `/api/workspaces/${encodeURIComponent(workspaceId)}`
  const projectNames = [`${tag} Site`, `${tag} Reel`]
  const projectIds: string[] = []
  const projectChatIds: string[] = []
  for (const name of projectNames) {
    const project = await post(client, '/api/projects', { name, workspaceId }, 'project')
    const projectId = project?.data?.id ?? project?.id
    projectIds.push(projectId)
    const session = await post(
      client,
      '/api/chat-sessions',
      { contextType: 'project', contextId: projectId, inferredName: `${name} chat` },
      'project chat',
    )
    const sessionId = session?.data?.id ?? session?.id
    projectChatIds.push(sessionId)
    await post(
      client,
      '/api/chat-messages',
      { sessionId, role: 'user', content: `${tag}: hello from ${name}` },
      'project chat message',
    )
  }

  const workspaceChat = await post(client, `${ws}/sessions`, { name: `${tag} plan` }, 'workspace chat')
  const workspaceChatId = workspaceChat.session.id
  await post(
    client,
    '/api/chat-messages',
    { sessionId: workspaceChatId, role: 'user', content: `${tag}: what is on this week?` },
    'workspace chat message',
  )

  const channelName = `${tag.toLowerCase()}-launch`
  const channel = await post(client, `${ws}/conversations`, { name: channelName, kind: 'public' }, 'channel')
  const channelId = channel.conversation.id
  const conv = `/api/conversations/${encodeURIComponent(channelId)}`
  const messageTexts = [`${tag}: kickoff`, `${tag}: second note`]
  const first = await post(client, `${conv}/messages`, { text: messageTexts[0] }, 'channel message')
  const threadRootId = first.message.id
  await post(client, `${conv}/messages`, { text: messageTexts[1] }, 'channel message')
  const replyText = `${tag}: reply in thread`
  await post(client, `${conv}/messages`, { text: replyText, threadRootId }, 'thread reply')

  const docTitle = `${tag} launch plan`
  await put(client, `${conv}/doc`, { title: docTitle, content: `# ${docTitle}\n\nShip it.`, baseVersion: 0 }, 'channel doc')

  const board = await post(client, `${ws}/boards`, { name: `${tag} Board`, conversationId: channelId }, 'board')
  const boardId = board.board?.id ?? board.id
  const itemTitle = `${tag} first card`
  const item = await post(client, `/api/boards/${encodeURIComponent(boardId)}/items`, { title: itemTitle }, 'card')
  const itemId = item.item?.id ?? item.workItem?.id ?? item.id

  const scheduleName = `${tag} daily digest`
  const schedule = await post(
    client,
    `${ws}/schedules`,
    { name: scheduleName, prompt: 'Summarise the day', cronExpression: '0 9 * * *', enabled: false },
    'schedule',
  )
  const scheduleId = schedule.schedule?.id ?? schedule.id

  const triggerName = `${tag} welcome`
  const trigger = await post(
    client,
    `${ws}/triggers`,
    { name: triggerName, eventType: 'member.joined', prompt: 'Welcome them', target: 'agent' },
    'trigger',
  )
  const triggerId = trigger.trigger?.id ?? trigger.id

  return {
    workspaceId,
    tag,
    projectIds,
    projectNames,
    projectChatIds,
    workspaceChatId,
    channelId,
    channelName,
    threadRootId,
    messageTexts,
    replyText,
    boardId,
    itemId,
    itemTitle,
    docTitle,
    scheduleId,
    scheduleName,
    triggerId,
    triggerName,
  }
}

export interface Surface {
  name: string
  /** The path a screen asks for, built the way the screen builds it. */
  path: (s: Seeded) => string
  /** What a person sees, reduced to stable fields so two answers compare. */
  view: (data: any, s: Seeded) => unknown
  /** The seeded content this surface must show. */
  shows: (view: any, s: Seeded) => void
}

const byId = <T extends { id?: string }>(rows: T[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
const ws = (s: Seeded) => `/api/workspaces/${encodeURIComponent(s.workspaceId)}`
const conv = (s: Seeded) => `/api/conversations/${encodeURIComponent(s.channelId)}`

function includes(haystack: unknown, needle: string, surface: string): void {
  const text = JSON.stringify(haystack)
  if (!text.includes(needle)) throw new Error(`${surface} does not show "${needle}": ${text.slice(0, 600)}`)
}

export const SURFACES: Surface[] = [
  {
    name: 'projects',
    path: (s) => `/api/projects?workspaceId=${encodeURIComponent(s.workspaceId)}`,
    view: (d) => byId((d?.items ?? []).map((p: any) => ({ id: p.id, name: p.name }))),
    shows: (v, s) => s.projectNames.forEach((n) => includes(v, n, 'projects')),
  },
  ...[0, 1].map(
    (i): Surface => ({
      name: `project ${i + 1} chats`,
      path: (s) => `/api/chat-sessions?contextId=${encodeURIComponent(s.projectIds[i])}&limit=50&offset=0`,
      view: (d) => byId((d?.items ?? []).map((c: any) => ({ id: c.id, name: c.name ?? c.inferredName }))),
      shows: (v, s) => includes(v, s.projectChatIds[i], `project ${i + 1} chats`),
    }),
  ),
  {
    name: 'project chat messages',
    path: (s) => `/api/chat-messages?sessionId=${encodeURIComponent(s.projectChatIds[0])}&limit=50&offset=0`,
    view: (d) => byId((d?.items ?? []).map((m: any) => ({ id: m.id, role: m.role, content: m.content }))),
    shows: (v, s) => includes(v, `${s.tag}: hello from ${s.projectNames[0]}`, 'project chat messages'),
  },
  {
    name: 'workspace chats',
    path: (s) => `${ws(s)}/sessions`,
    view: (d) => byId((d?.sessions ?? []).map((c: any) => ({ id: c.id, name: c.name ?? c.inferredName }))),
    shows: (v, s) => includes(v, s.workspaceChatId, 'workspace chats'),
  },
  {
    name: 'workspace chat messages',
    path: (s) => `/api/chat-messages?sessionId=${encodeURIComponent(s.workspaceChatId)}&limit=50&offset=0`,
    view: (d) => byId((d?.items ?? []).map((m: any) => ({ id: m.id, role: m.role, content: m.content }))),
    shows: (v, s) => includes(v, `${s.tag}: what is on this week?`, 'workspace chat messages'),
  },
  {
    name: 'channels',
    path: (s) => `${ws(s)}/conversations`,
    view: (d) =>
      byId(
        (d?.conversations ?? [])
          .filter((c: any) => c.kind !== 'dm' && c.kind !== 'group_dm')
          .map((c: any) => ({ id: c.id, kind: c.kind, name: c.name, hasDoc: c.hasDoc })),
      ),
    shows: (v, s) => {
      includes(v, s.channelName, 'channels')
      includes(v, 'general', 'channels')
    },
  },
  {
    name: 'channel messages',
    path: (s) => `${conv(s)}/messages?limit=50`,
    view: (d) =>
      byId(
        (d?.messages ?? []).map((m: any) => ({
          id: m.id,
          text: m.text,
          threadRootId: m.threadRootId ?? null,
          replyCount: m.replyCount ?? 0,
        })),
      ),
    shows: (v, s) => s.messageTexts.forEach((t) => includes(v, t, 'channel messages')),
  },
  {
    name: 'thread',
    path: (s) => `${conv(s)}/messages?threadRootId=${encodeURIComponent(s.threadRootId)}&limit=50`,
    view: (d) => byId((d?.messages ?? []).map((m: any) => ({ id: m.id, text: m.text }))),
    shows: (v, s) => includes(v, s.replyText, 'thread'),
  },
  {
    name: 'channel doc',
    path: (s) => `${conv(s)}/doc`,
    view: (d) => ({ title: d?.doc?.title ?? d?.title ?? null, content: d?.doc?.content ?? d?.content ?? null }),
    shows: (v, s) => includes(v, s.docTitle, 'channel doc'),
  },
  {
    name: 'boards',
    path: (s) => `${ws(s)}/boards`,
    view: (d) => byId((d?.boards ?? d?.items ?? []).map((b: any) => ({ id: b.id, name: b.name }))),
    shows: (v, s) => includes(v, s.boardId, 'boards'),
  },
  {
    name: 'board',
    path: (s) => `/api/boards/${encodeURIComponent(s.boardId)}`,
    view: (d) => {
      const items = d?.items ?? d?.board?.items ?? []
      return byId(items.map((i: any) => ({ id: i.id, title: i.title, key: i.key })))
    },
    shows: (v, s) => includes(v, s.itemTitle, 'board'),
  },
  {
    name: 'card',
    path: (s) => `/api/work-items/${encodeURIComponent(s.itemId)}`,
    view: (d) => {
      const i = d?.item ?? d?.workItem ?? d
      return { id: i?.id, title: i?.title, key: i?.key }
    },
    shows: (v, s) => includes(v, s.itemTitle, 'card'),
  },
  {
    name: 'schedules',
    path: (s) => `${ws(s)}/schedules`,
    view: (d) => byId((d?.schedules ?? d?.items ?? []).map((x: any) => ({ id: x.id, name: x.name }))),
    shows: (v, s) => includes(v, s.scheduleName, 'schedules'),
  },
  {
    name: 'triggers',
    path: (s) => `${ws(s)}/triggers`,
    view: (d) => byId((d?.triggers ?? d?.items ?? []).map((x: any) => ({ id: x.id, name: x.name }))),
    shows: (v, s) => includes(v, s.triggerName, 'triggers'),
  },
  {
    name: 'activity',
    path: (s) => `${ws(s)}/activity?limit=100`,
    view: (d) => byId((d?.activity ?? []).map((a: any) => ({ id: a.id, kind: a.kind ?? a.type ?? null }))),
    shows: () => {},
  },
  {
    name: 'people and agents',
    path: (s) => `${ws(s)}/mentionables`,
    view: (d) => ({
      people: byId((d?.people ?? []).map((p: any) => ({ id: p.id, name: p.name, role: p.role }))),
      agents: [...(d?.agents ?? [])]
        .map((a: any) => ({ key: a.key, name: a.name }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }),
    shows: (v, s) => {
      s.projectNames.forEach((n) => includes(v.agents, n, 'agents'))
      if (!v.people.length) throw new Error('people and agents lists nobody')
    },
  },
  {
    name: 'workspace agent profile',
    path: (s) => `${ws(s)}/agent-profile`,
    view: (d) => ({ id: d?.profile?.id ?? null, name: d?.profile?.name ?? null }),
    shows: (v) => {
      if (!v.name) throw new Error(`workspace agent profile has no name: ${JSON.stringify(v)}`)
    },
  },
]
