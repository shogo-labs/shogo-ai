// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { chatActivityEvents, chatSessionEvents } from "./chat-session-events"

export interface IslandFileAttachment {
  dataUrl: string
  name: string
  type: string
}

export type IslandPermissionDecision =
  | "allow_once"
  | "always_allow"
  | "deny"

export interface IslandPermissionRequest {
  id: string
  toolName: string
  category: string
  params: Record<string, unknown>
  reason: string
  timeout: number
}

export interface IslandQuestionRequest {
  id: string
  prompt: string
  options: Array<{ label: string; description?: string }>
}

export type IslandPendingRequest =
  | {
      kind: "permission"
      request: IslandPermissionRequest
    }
  | {
      kind: "question"
      request: IslandQuestionRequest
    }

export interface DesktopIslandSession {
  sessionId: string
  projectId: string
  projectName: string
  title: string
  status: "idle" | "running" | "done" | "needs_approval" | "needs_answer"
  step?: string
  replyPreview?: string
  pending?: IslandPendingRequest
}

export interface DesktopIslandProject {
  projectId: string
  name: string
}

export interface DesktopIslandSnapshot {
  sessions: DesktopIslandSession[]
  recentProjects: DesktopIslandProject[]
  updatedAt: number
}

export type DesktopIslandTarget =
  | { kind: "session"; projectId: string; sessionId: string }
  | { kind: "new"; projectId: string }

export type DesktopIslandAction =
  | {
      type: "open"
      projectId: string
      sessionId: string
    }
  | {
      type: "permission"
      requestId: string
      decision: IslandPermissionDecision
      pattern?: string
    }
  | {
      type: "question"
      requestId: string
      response: string
    }
  | {
      type: "send"
      target: DesktopIslandTarget
      text: string
      files?: IslandFileAttachment[]
    }

interface DesktopIslandBridge {
  islandUpdate?: (snapshot: DesktopIslandSnapshot) => void
  onIslandAction?: (callback: (action: DesktopIslandAction) => void) => void
  removeIslandActionListener?: () => void
}

interface RegisteredIslandSession {
  sessionId: string
  projectId: string
  projectName: string
  title: string
  status: DesktopIslandSession["status"]
  step?: string
  replyPreview?: string
  pending?: IslandPendingRequest
  sendMessage: (text: string, files?: IslandFileAttachment[]) => void | Promise<void>
  respondPermission?: (
    requestId: string,
    decision: IslandPermissionDecision,
    pattern?: string,
  ) => void | Promise<void>
  respondQuestion?: (requestId: string, response: string) => void | Promise<void>
}

interface PendingSend {
  target: DesktopIslandTarget
  text: string
  files?: IslandFileAttachment[]
}

const sessions = new Map<string, RegisteredIslandSession>()
const activityByProject = new Map<
  string,
  { streamingSessionIds: Set<string>; completedSessionIds: Set<string> }
>()
const pendingSends = new Map<string, PendingSend>()

let actionListenerInstalled = false
let publishTimer: ReturnType<typeof setTimeout> | null = null
let lastSnapshot: DesktopIslandSnapshot = {
  sessions: [],
  recentProjects: [],
  updatedAt: Date.now(),
}

function getBridge(): DesktopIslandBridge | null {
  if (typeof window === "undefined") return null
  return (window as unknown as { shogoDesktop?: DesktopIslandBridge }).shogoDesktop ?? null
}

function projectKey(projectId: string): string {
  return `new:${projectId}`
}

function sessionKey(projectId: string, sessionId: string): string {
  return `session:${projectId}:${sessionId}`
}

function installActionListener(): void {
  if (actionListenerInstalled) return
  const bridge = getBridge()
  if (!bridge?.onIslandAction) return
  actionListenerInstalled = true
  bridge.onIslandAction((action) => {
    void handleAction(action)
  })
}

function schedulePublish(): void {
  installActionListener()
  if (publishTimer !== null) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    publishSnapshot()
  }, 50)
}

function snapshotSession(session: RegisteredIslandSession): DesktopIslandSession {
  const activity = activityByProject.get(session.projectId)
  const isStreaming = activity?.streamingSessionIds.has(session.sessionId) ?? false
  const isCompleted = activity?.completedSessionIds.has(session.sessionId) ?? false

  let status = session.status
  if (session.pending?.kind === "permission") status = "needs_approval"
  else if (session.pending?.kind === "question") status = "needs_answer"
  else if (isStreaming) status = "running"
  else if (isCompleted) status = "done"

  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    projectName: session.projectName,
    title: session.title || "Untitled chat",
    status,
    ...(session.step ? { step: session.step } : {}),
    ...(session.replyPreview ? { replyPreview: session.replyPreview.slice(-400) } : {}),
    ...(session.pending ? { pending: session.pending } : {}),
  }
}

function publishSnapshot(): void {
  const seenProjects = new Set<string>()
  const nextSessions = [...sessions.values()].map((session) => {
    seenProjects.add(session.projectId)
    return snapshotSession(session)
  })
  const recentProjects = [...sessions.values()]
    .filter((session) => {
      if (seenProjects.has(session.projectId)) {
        seenProjects.delete(session.projectId)
        return true
      }
      return false
    })
    .map((session) => ({ projectId: session.projectId, name: session.projectName }))

  lastSnapshot = {
    sessions: nextSessions,
    recentProjects,
    updatedAt: Date.now(),
  }
  getBridge()?.islandUpdate?.(lastSnapshot)
}

async function handleAction(action: DesktopIslandAction): Promise<void> {
  if (action.type === "open") {
    chatSessionEvents.requestSelect({
      projectId: action.projectId,
      sessionId: action.sessionId,
    })
    return
  }

  if (action.type === "permission" || action.type === "question") {
    for (const session of sessions.values()) {
      const pending = session.pending
      if (!pending || pending.request.id !== action.requestId) continue
      if (action.type === "permission" && pending.kind === "permission") {
        await session.respondPermission?.(
          action.requestId,
          action.decision,
          action.pattern,
        )
      } else if (action.type === "question" && pending.kind === "question") {
        await session.respondQuestion?.(action.requestId, action.response)
      }
      return
    }
    return
  }

  if (action.type !== "send") return
  const targetKey =
    action.target.kind === "session"
      ? sessionKey(action.target.projectId, action.target.sessionId)
      : projectKey(action.target.projectId)
  const registered =
    action.target.kind === "session" ? sessions.get(targetKey) : undefined

  if (registered) {
    await registered.sendMessage(action.text, action.files)
    return
  }

  pendingSends.set(targetKey, {
    target: action.target,
    text: action.text,
    files: action.files,
  })
  if (action.target.kind === "session") {
    chatSessionEvents.requestSelect({
      projectId: action.target.projectId,
      sessionId: action.target.sessionId,
    })
  } else {
    chatSessionEvents.requestNewChat({ projectId: action.target.projectId })
  }
}

function consumePendingSend(
  projectId: string,
  sessionId: string,
): PendingSend | undefined {
  const directKey = sessionKey(projectId, sessionId)
  const direct = pendingSends.get(directKey)
  if (direct) {
    pendingSends.delete(directKey)
    return direct
  }
  return undefined
}

export interface RegisterIslandSessionOptions {
  sessionId: string
  projectId: string
  projectName?: string
  title?: string
  status?: DesktopIslandSession["status"]
  step?: string
  replyPreview?: string
  pending?: IslandPendingRequest
  sendMessage: (text: string, files?: IslandFileAttachment[]) => void | Promise<void>
  respondPermission?: RegisteredIslandSession["respondPermission"]
  respondQuestion?: RegisteredIslandSession["respondQuestion"]
}

export function registerDesktopIslandSession(
  options: RegisterIslandSessionOptions,
): () => void {
  const session: RegisteredIslandSession = {
    sessionId: options.sessionId,
    projectId: options.projectId,
    projectName: options.projectName ?? "Project",
    title: options.title ?? "Untitled chat",
    status: options.status ?? "idle",
    step: options.step,
    replyPreview: options.replyPreview,
    pending: options.pending,
    sendMessage: options.sendMessage,
    respondPermission: options.respondPermission,
    respondQuestion: options.respondQuestion,
  }
  sessions.set(sessionKey(session.projectId, session.sessionId), session)
  schedulePublish()

  const pendingSend = consumePendingSend(session.projectId, session.sessionId)
  if (pendingSend) {
    void session.sendMessage(pendingSend.text, pendingSend.files)
  }

  return () => {
    const key = sessionKey(session.projectId, session.sessionId)
    if (sessions.get(key) === session) {
      sessions.delete(key)
      schedulePublish()
    }
  }
}

export function updateDesktopIslandSession(
  options: Omit<RegisterIslandSessionOptions, "sendMessage"> & {
    sendMessage?: RegisterIslandSessionOptions["sendMessage"]
  },
): void {
  const session = sessions.get(sessionKey(options.projectId, options.sessionId))
  if (!session) return
  session.projectName = options.projectName ?? session.projectName
  session.title = options.title ?? session.title
  session.status = options.status ?? session.status
  session.step = options.step
  session.replyPreview = options.replyPreview
  session.pending = options.pending
  if (options.sendMessage) session.sendMessage = options.sendMessage
  session.respondPermission = options.respondPermission
  session.respondQuestion = options.respondQuestion
  schedulePublish()
}

export function deliverPendingDesktopIslandNewChat(
  projectId: string,
  sessionId: string,
): void {
  const pending = pendingSends.get(projectKey(projectId))
  if (!pending) return
  pendingSends.delete(projectKey(projectId))
  const session = sessions.get(sessionKey(projectId, sessionId))
  if (session) void session.sendMessage(pending.text, pending.files)
  else pendingSends.set(sessionKey(projectId, sessionId), pending)
}

export function getDesktopIslandSnapshot(): DesktopIslandSnapshot {
  return lastSnapshot
}

chatActivityEvents.subscribe((event) => {
  activityByProject.set(event.projectId, {
    streamingSessionIds: new Set(event.streamingSessionIds),
    completedSessionIds: new Set(event.completedSessionIds),
  })
  schedulePublish()
})
