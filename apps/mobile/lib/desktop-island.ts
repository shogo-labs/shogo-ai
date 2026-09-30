// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Renderer half of the desktop island. Wire shapes mirror
// apps/desktop/src/island-protocol.ts, which re-validates everything sent
// from here.

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
  /** Set by the main process when a large string param was cut short. */
  paramsTruncated?: boolean
  reason: string
  timeout: number
}

export interface IslandQuestionRequest {
  id: string
  prompt: string
  options: Array<{ label: string; description?: string }>
  /** Multi-question or multi-select prompts can only be answered in the app. */
  answerInApp: boolean
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

export interface IslandPlanSummary {
  name: string
  overview: string
  plan: string
  todos: Array<{ id: string; content: string }>
  filepath?: string
  toolCallId?: string
}

type SnapshotPending =
  | {
      kind: "permission"
      request: IslandPermissionRequest & { startedAt: number }
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
  lastActivityAt?: number
  pending?: SnapshotPending
  pendingPlan?: IslandPlanSummary
}

export interface DesktopIslandProject {
  projectId: string
  name: string
}

export interface DesktopIslandSnapshot {
  sessions: DesktopIslandSession[]
  recentProjects: DesktopIslandProject[]
  /** `${projectId}:${sessionId}` of the chat visible in this window. */
  focusedSessionKey?: string
  notice?: string
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
  | { type: "stop"; projectId: string; sessionId: string }
  | {
      type: "plan"
      projectId: string
      sessionId: string
      decision: "build" | "feedback"
      modelId?: string
      text?: string
    }

/** Where to route when the target project isn't mounted in this window. */
export type DesktopIslandNavigation =
  | { projectId: string; sessionId: string }
  | { projectId: string; newChat: true }

interface DesktopIslandBridge {
  islandUpdate?: (snapshot: DesktopIslandSnapshot) => void
  onIslandAction?: (callback: (action: DesktopIslandAction) => void) => void
}

export interface DesktopIslandSessionState {
  projectName: string
  title: string
  status: DesktopIslandSession["status"]
  step?: string
  replyPreview?: string
  pending?: IslandPendingRequest
  pendingPlan?: IslandPlanSummary
  /** This chat is the one on screen in its window. */
  focused?: boolean
}

export interface DesktopIslandSessionHandlers {
  sendMessage: (text: string, files?: IslandFileAttachment[]) => void | Promise<void>
  respondPermission?: (
    requestId: string,
    decision: IslandPermissionDecision,
    pattern?: string,
  ) => void | Promise<void>
  respondQuestion?: (requestId: string, response: string) => void | Promise<void>
  stop?: () => void | Promise<void>
  buildPlan?: (modelId?: string) => void | Promise<void>
  sendPlanFeedback?: (text: string) => void | Promise<void>
}

type RegisteredIslandSession = DesktopIslandSessionState &
  DesktopIslandSessionHandlers & {
    sessionId: string
    projectId: string
    lastActivityAt: number
  }

interface PendingSend {
  text: string
  files?: IslandFileAttachment[]
  label: string
  expiry: ReturnType<typeof setTimeout>
}

export const PENDING_SEND_TTL_MS = 60_000
const NOTICE_TTL_MS = 10_000

const sessions = new Map<string, RegisteredIslandSession>()
const activityByProject = new Map<
  string,
  { streamingSessionIds: Set<string>; completedSessionIds: Set<string> }
>()
const pendingSends = new Map<string, PendingSend>()
const permissionSeenAt = new Map<string, number>()

let navigator: ((navigation: DesktopIslandNavigation) => void) | null = null
let notice: { text: string; expiresAt: number } | null = null
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

function isProjectMounted(projectId: string): boolean {
  for (const session of sessions.values()) {
    if (session.projectId === projectId) return true
  }
  return false
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

function showNotice(text: string): void {
  notice = { text, expiresAt: Date.now() + NOTICE_TTL_MS }
  schedulePublish()
  setTimeout(schedulePublish, NOTICE_TTL_MS + 10)
}

function snapshotPending(pending: IslandPendingRequest | undefined): SnapshotPending | undefined {
  if (pending?.kind !== "permission") return pending
  let startedAt = permissionSeenAt.get(pending.request.id)
  if (startedAt === undefined) {
    startedAt = Date.now()
    permissionSeenAt.set(pending.request.id, startedAt)
  }
  return { kind: "permission", request: { ...pending.request, startedAt } }
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

  const pending = snapshotPending(session.pending)
  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    projectName: session.projectName,
    title: session.title || "Untitled chat",
    status,
    ...(session.step ? { step: session.step } : {}),
    ...(session.replyPreview ? { replyPreview: session.replyPreview.slice(-400) } : {}),
    lastActivityAt: session.lastActivityAt,
    ...(pending ? { pending } : {}),
    ...(session.pendingPlan ? { pendingPlan: session.pendingPlan } : {}),
  }
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true
  return document.visibilityState !== "hidden"
}

function publishSnapshot(): void {
  const livePermissionIds = new Set<string>()
  const recentProjects = new Map<string, DesktopIslandProject>()
  const nextSessions = [...sessions.values()].map((session) => {
    if (session.pending?.kind === "permission") livePermissionIds.add(session.pending.request.id)
    if (!recentProjects.has(session.projectId)) {
      recentProjects.set(session.projectId, { projectId: session.projectId, name: session.projectName })
    }
    return snapshotSession(session)
  })
  for (const id of permissionSeenAt.keys()) {
    if (!livePermissionIds.has(id)) permissionSeenAt.delete(id)
  }
  if (notice && notice.expiresAt <= Date.now()) notice = null

  const focused = isWindowFocused()
    ? [...sessions.values()].find((session) => session.focused)
    : undefined
  lastSnapshot = {
    sessions: nextSessions,
    recentProjects: [...recentProjects.values()],
    ...(focused ? { focusedSessionKey: `${focused.projectId}:${focused.sessionId}` } : {}),
    ...(notice ? { notice: notice.text } : {}),
    updatedAt: Date.now(),
  }
  getBridge()?.islandUpdate?.(lastSnapshot)
}

function queueSend(
  key: string,
  message: { text: string; files?: IslandFileAttachment[] },
  label: string,
): void {
  const existing = pendingSends.get(key)
  if (existing) clearTimeout(existing.expiry)
  const entry: PendingSend = {
    ...message,
    label,
    expiry: setTimeout(() => {
      if (pendingSends.get(key) !== entry) return
      pendingSends.delete(key)
      showNotice(`Couldn't deliver your message to ${label}. Open it in Shogo and try again.`)
    }, PENDING_SEND_TTL_MS),
  }
  pendingSends.set(key, entry)
}

function takePendingSend(key: string): PendingSend | undefined {
  const pending = pendingSends.get(key)
  if (!pending) return undefined
  clearTimeout(pending.expiry)
  pendingSends.delete(key)
  return pending
}

async function handleAction(action: DesktopIslandAction): Promise<void> {
  if (action.type === "open") {
    if (isProjectMounted(action.projectId)) {
      chatSessionEvents.requestSelect({
        projectId: action.projectId,
        sessionId: action.sessionId,
      })
    } else {
      navigator?.({ projectId: action.projectId, sessionId: action.sessionId })
    }
    return
  }

  if (action.type === "stop" || action.type === "plan") {
    const registered = sessions.get(sessionKey(action.projectId, action.sessionId))
    if (!registered) return
    if (action.type === "stop") await registered.stop?.()
    else if (action.decision === "build") await registered.buildPlan?.(action.modelId)
    else if (action.text) await registered.sendPlanFeedback?.(action.text)
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

  const { target } = action
  if (target.kind === "session") {
    const registered = sessions.get(sessionKey(target.projectId, target.sessionId))
    if (registered) {
      await registered.sendMessage(action.text, action.files)
      return
    }
  }

  const mounted = isProjectMounted(target.projectId)
  if (!mounted && !navigator) {
    showNotice("Couldn't open that chat. Open it in Shogo and try again.")
    return
  }

  if (target.kind === "session") {
    queueSend(sessionKey(target.projectId, target.sessionId), action, "that chat")
    if (mounted) chatSessionEvents.requestSelect(target)
    else navigator?.({ projectId: target.projectId, sessionId: target.sessionId })
  } else {
    queueSend(projectKey(target.projectId), action, "a new chat")
    if (mounted) chatSessionEvents.requestNewChat({ projectId: target.projectId })
    else navigator?.({ projectId: target.projectId, newChat: true })
  }
}

/** Installed once at the app root so the island can open projects that
 * aren't mounted in this window. */
export function setDesktopIslandNavigator(
  next: ((navigation: DesktopIslandNavigation) => void) | null,
): void {
  navigator = next
}

export function registerDesktopIslandSession(
  options: { sessionId: string; projectId: string } & Partial<DesktopIslandSessionState> &
    DesktopIslandSessionHandlers,
): () => void {
  const session: RegisteredIslandSession = {
    ...options,
    projectName: options.projectName ?? "Project",
    title: options.title ?? "Untitled chat",
    status: options.status ?? "idle",
    lastActivityAt: Date.now(),
  }
  const key = sessionKey(session.projectId, session.sessionId)
  sessions.set(key, session)
  schedulePublish()

  const pendingSend = takePendingSend(key)
  if (pendingSend) {
    void session.sendMessage(pendingSend.text, pendingSend.files)
  }

  return () => {
    if (sessions.get(key) === session) {
      sessions.delete(key)
      schedulePublish()
    }
  }
}

export function updateDesktopIslandSession(
  projectId: string,
  sessionId: string,
  state: DesktopIslandSessionState,
): void {
  const session = sessions.get(sessionKey(projectId, sessionId))
  if (!session) return
  if (
    state.status !== session.status ||
    state.replyPreview !== session.replyPreview ||
    state.pending?.request.id !== session.pending?.request.id ||
    state.pendingPlan?.toolCallId !== session.pendingPlan?.toolCallId
  ) {
    session.lastActivityAt = Date.now()
  }
  Object.assign(session, state)
  if (!("pendingPlan" in state)) session.pendingPlan = undefined
  if (!("pending" in state)) session.pending = undefined
  schedulePublish()
}

export function deliverPendingDesktopIslandNewChat(
  projectId: string,
  sessionId: string,
): void {
  const pending = takePendingSend(projectKey(projectId))
  if (!pending) return
  const session = sessions.get(sessionKey(projectId, sessionId))
  if (session) {
    void session.sendMessage(pending.text, pending.files)
    return
  }
  queueSend(sessionKey(projectId, sessionId), pending, pending.label)
}

export function getDesktopIslandSnapshot(): DesktopIslandSnapshot {
  return lastSnapshot
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (sessions.size > 0) schedulePublish()
  })
}

chatActivityEvents.subscribe((event) => {
  activityByProject.set(event.projectId, {
    streamingSessionIds: new Set(event.streamingSessionIds),
    completedSessionIds: new Set(event.completedSessionIds),
  })
  schedulePublish()
})
