// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Wire types shared by the island main process, its preload, and the
// `/island` route of the app. The app side (apps/mobile/lib/desktop-island.ts
// and apps/mobile/components/island) mirrors these shapes; everything crossing
// IPC is re-validated here.

export const ISLAND_MODES = ['hidden', 'collapsed', 'expanded', 'compose'] as const
export type IslandMode = (typeof ISLAND_MODES)[number]

export type IslandStatus = 'idle' | 'running' | 'done' | 'needs_approval' | 'needs_answer'
const ISLAND_STATUSES: readonly IslandStatus[] = ['idle', 'running', 'done', 'needs_approval', 'needs_answer']

export type IslandPermissionDecision = 'allow_once' | 'always_allow' | 'deny'
const ISLAND_DECISIONS: readonly IslandPermissionDecision[] = ['allow_once', 'always_allow', 'deny']

/** Per-string cap on permission params and plan bodies. A `write_file` of a
 * large file would otherwise be copied through IPC on every streaming tick. */
export const ISLAND_MAX_PARAM_CHARS = 20_000

export interface IslandPermissionRequest {
  id: string
  toolName: string
  category: string
  reason: string
  params: Record<string, unknown>
  /** True when at least one string param was cut to ISLAND_MAX_PARAM_CHARS. */
  paramsTruncated?: boolean
  timeout: number
  startedAt: number
}

export interface IslandQuestionRequest {
  id: string
  prompt: string
  options: Array<{ label: string; description?: string }>
  /** Multi-question or multi-select prompts can only be answered in the app. */
  answerInApp: boolean
}

export type IslandPending =
  | { kind: 'permission'; request: IslandPermissionRequest }
  | { kind: 'question'; request: IslandQuestionRequest }

export interface IslandPlan {
  name: string
  overview: string
  plan: string
  todos: Array<{ id: string; content: string }>
  filepath?: string
  toolCallId?: string
}

export interface IslandSession {
  sessionId: string
  projectId: string
  projectName: string
  title: string
  status: IslandStatus
  step?: string
  replyPreview?: string
  lastActivityAt?: number
  pending?: IslandPending
  pendingPlan?: IslandPlan
}

export interface IslandProject {
  projectId: string
  name: string
}

export interface IslandSnapshot {
  sessions: IslandSession[]
  recentProjects: IslandProject[]
  /** `${projectId}:${sessionId}` of the chat visible in a focused app window. */
  focusedSessionKey?: string
  notice?: string
  /** The signed-in user's Shogo buddy accessories. */
  buddyLook?: IslandBuddyLook
  updatedAt: number
}

export const ISLAND_BUDDY_TOPPERS = [
  'orb',
  'stubby',
  'ears',
  'fox',
  'bunny',
  'bear',
  'horns',
  'halo',
  'sprout',
  'crown',
  'party',
  'beanie',
  'wizard',
  'headphones',
  'none',
] as const
export const ISLAND_BUDDY_FACES = ['classic', 'visor', 'screen'] as const
export const ISLAND_BUDDY_TAILS = ['none', 'fox', 'cat', 'bunny', 'dragon', 'cable'] as const
export const ISLAND_BUDDY_EYEWEAR = ['none', 'sunglasses', 'nerd', 'monocle', 'stars', '3d', 'goggles'] as const
export const ISLAND_BUDDY_NECKS = ['none', 'scarf', 'bandana', 'bowtie'] as const

export interface IslandBuddyLook {
  topper: (typeof ISLAND_BUDDY_TOPPERS)[number]
  face: (typeof ISLAND_BUDDY_FACES)[number]
  tail: (typeof ISLAND_BUDDY_TAILS)[number]
  eyewear: (typeof ISLAND_BUDDY_EYEWEAR)[number]
  neck: (typeof ISLAND_BUDDY_NECKS)[number]
  bolts: boolean
  blush: boolean
}

export const EMPTY_ISLAND_SNAPSHOT: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }

export function islandSessionKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`
}

export type IslandTarget =
  | { kind: 'session'; projectId: string; sessionId: string }
  | { kind: 'new'; projectId: string }

/** A file the island asks the main process to attach, identified by path. */
export interface IslandFileRef {
  path: string
  name: string
  type: string
}

/** A file after the main process has read and size-checked it. */
export interface IslandAttachment {
  dataUrl: string
  name: string
  type: string
}

export type IslandReadFilesResult = { ok: true; attachments: IslandAttachment[] } | { ok: false; error: string }

export type IslandPlanDecision = 'build' | 'feedback'

type IslandActionBase =
  | { type: 'open'; projectId: string; sessionId: string }
  | { type: 'permission'; requestId: string; decision: IslandPermissionDecision; pattern?: string }
  | { type: 'question'; requestId: string; response: string }
  | { type: 'stop'; projectId: string; sessionId: string }
  | {
      type: 'plan'
      projectId: string
      sessionId: string
      decision: IslandPlanDecision
      modelId?: string
      text?: string
    }
  /** Focus the primary window and navigate it to an in-app path. */
  | { type: 'navigate'; path: string }

export const ISLAND_MEETING_DECISIONS = ['record', 'always', 'dismiss', 'stop'] as const
export type IslandMeetingDecision = (typeof ISLAND_MEETING_DECISIONS)[number]

/** A detected call Shogo is asking to record. */
export interface IslandMeetingPrompt {
  id: string
  app: string
  detectedAt: number
  /** The user has said yes a few times; offer to always record. */
  suggestAutoRecord: boolean
}

export interface IslandMeetingRecording {
  id: string
  startedAt: number
  app?: string
}

/** Meeting detection and recording, owned by the main process. */
export interface IslandMeetingState {
  prompt?: IslandMeetingPrompt
  recording?: IslandMeetingRecording
  /** Set while a start or stop is in flight. */
  busy?: boolean
  error?: string
}

export const EMPTY_ISLAND_MEETING_STATE: IslandMeetingState = {}

/** Island renderer -> main process. */
export type IslandAction =
  | IslandActionBase
  | { type: 'send'; target: IslandTarget; text: string; files?: IslandFileRef[] }
  | { type: 'meeting'; decision: IslandMeetingDecision; promptId?: string }

/** Main process -> app renderer. */
export type IslandAppAction =
  | IslandActionBase
  | { type: 'send'; target: IslandTarget; text: string; files?: IslandAttachment[] }

export type IslandActionResult = { ok: true } | { ok: false; error: string }

export interface IslandLayout {
  mode: IslandMode
  notched: boolean
  /** Height of the menu bar strip the island overlaps on a notched display. */
  topInset: number
  sounds: boolean
  soundVolume: number
}

/** Exposed to the island route as `window.shogoIsland`. */
export interface IslandBridge {
  onSnapshot(callback: (snapshot: IslandSnapshot) => void): () => void
  onLayout(callback: (layout: IslandLayout) => void): () => void
  onOpenCompose(callback: () => void): () => void
  onMeeting(callback: (state: IslandMeetingState) => void): () => void
  /** Replays the latest snapshot, layout, and meeting state, for listeners that attach late. */
  requestState(): void
  sendAction(action: IslandAction): Promise<IslandActionResult>
  readFiles(files: IslandFileRef[]): Promise<IslandReadFilesResult>
  setMode(mode: IslandMode): void
  setInteractive(interactive: boolean): void
  /** Height of the rendered card, so the window never covers more than it draws. */
  setContentHeight(height: number): void
  getPathForFile(file: File): string
}

export interface IslandConfig {
  enabled: boolean
  autoHide: boolean
  shortcut: string
  sounds: boolean
  soundVolume: number
}

export const DEFAULT_ISLAND_SHORTCUT = 'CommandOrControl+Shift+Space'
export const DEFAULT_ISLAND_SOUND_VOLUME = 0.6

export function isIslandMode(value: unknown): value is IslandMode {
  return typeof value === 'string' && (ISLAND_MODES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function capped(value: string): string {
  return value.length > ISLAND_MAX_PARAM_CHARS ? value.slice(0, ISLAND_MAX_PARAM_CHARS) : value
}

function parseTarget(value: unknown): IslandTarget | null {
  if (!isRecord(value)) return null
  const projectId = nonEmpty(value.projectId)
  if (!projectId) return null
  if (value.kind === 'new') return { kind: 'new', projectId }
  const sessionId = nonEmpty(value.sessionId)
  if (value.kind === 'session' && sessionId) return { kind: 'session', projectId, sessionId }
  return null
}

export function parseIslandFileRef(value: unknown): IslandFileRef | null {
  if (!isRecord(value)) return null
  const path = nonEmpty(value.path)
  const name = nonEmpty(value.name)
  if (!path || !name) return null
  return { path, name, type: str(value.type) ?? '' }
}

export function parseIslandFileRefs(value: unknown): IslandFileRef[] | null {
  if (!Array.isArray(value)) return null
  const files: IslandFileRef[] = []
  for (const raw of value) {
    const file = parseIslandFileRef(raw)
    if (!file) return null
    files.push(file)
  }
  return files
}

/** In-app paths only: no scheme, no protocol-relative URLs. */
function parseAppPath(value: unknown): string | null {
  const path = nonEmpty(value)
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null
  return path
}

export function parseIslandAction(value: unknown): IslandAction | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'open':
    case 'stop': {
      const projectId = nonEmpty(value.projectId)
      const sessionId = nonEmpty(value.sessionId)
      return projectId && sessionId ? { type: value.type, projectId, sessionId } : null
    }
    case 'permission': {
      const requestId = nonEmpty(value.requestId)
      const decision = value.decision as IslandPermissionDecision
      if (!requestId || !ISLAND_DECISIONS.includes(decision)) return null
      const pattern = nonEmpty(value.pattern)
      return { type: 'permission', requestId, decision, ...(pattern ? { pattern } : {}) }
    }
    case 'question': {
      const requestId = nonEmpty(value.requestId)
      const response = nonEmpty(value.response)
      return requestId && response ? { type: 'question', requestId, response } : null
    }
    case 'plan': {
      const projectId = nonEmpty(value.projectId)
      const sessionId = nonEmpty(value.sessionId)
      if (!projectId || !sessionId) return null
      if (value.decision === 'build') {
        const modelId = nonEmpty(value.modelId)
        return { type: 'plan', projectId, sessionId, decision: 'build', ...(modelId ? { modelId } : {}) }
      }
      if (value.decision === 'feedback') {
        const text = str(value.text)?.trim()
        return text ? { type: 'plan', projectId, sessionId, decision: 'feedback', text } : null
      }
      return null
    }
    case 'navigate': {
      const path = parseAppPath(value.path)
      return path ? { type: 'navigate', path } : null
    }
    case 'meeting': {
      const decision = value.decision as IslandMeetingDecision
      if (!ISLAND_MEETING_DECISIONS.includes(decision)) return null
      const promptId = nonEmpty(value.promptId)
      return { type: 'meeting', decision, ...(promptId ? { promptId } : {}) }
    }
    case 'send': {
      const target = parseTarget(value.target)
      const text = str(value.text) ?? ''
      if (!target) return null
      let files: IslandFileRef[] | undefined
      if (value.files !== undefined) {
        const parsed = parseIslandFileRefs(value.files)
        if (!parsed) return null
        files = parsed
      }
      if (!text.trim() && !files?.length) return null
      return { type: 'send', target, text, ...(files?.length ? { files } : {}) }
    }
    default:
      return null
  }
}

function capParams(params: Record<string, unknown>): { params: Record<string, unknown>; truncated: boolean } {
  let truncated = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > ISLAND_MAX_PARAM_CHARS) {
      truncated = true
      out[key] = capped(value)
    } else {
      out[key] = value
    }
  }
  return { params: out, truncated }
}

function parsePending(value: unknown): IslandPending | undefined {
  if (!isRecord(value) || !isRecord(value.request)) return undefined
  const request = value.request
  const id = nonEmpty(request.id)
  if (!id) return undefined
  if (value.kind === 'permission') {
    const { params, truncated } = capParams(isRecord(request.params) ? request.params : {})
    return {
      kind: 'permission',
      request: {
        id,
        toolName: str(request.toolName) ?? '',
        category: str(request.category) ?? '',
        reason: str(request.reason) ?? '',
        params,
        ...(truncated || request.paramsTruncated === true ? { paramsTruncated: true } : {}),
        timeout: typeof request.timeout === 'number' ? request.timeout : 0,
        startedAt: typeof request.startedAt === 'number' ? request.startedAt : Date.now(),
      },
    }
  }
  if (value.kind === 'question') {
    const options = Array.isArray(request.options)
      ? request.options.flatMap((option) => {
          if (!isRecord(option)) return []
          const label = nonEmpty(option.label)
          if (!label) return []
          const description = str(option.description)
          return [{ label, ...(description ? { description } : {}) }]
        })
      : []
    return {
      kind: 'question',
      request: {
        id,
        prompt: str(request.prompt) ?? '',
        options,
        answerInApp: request.answerInApp === true || options.length === 0,
      },
    }
  }
  return undefined
}

function parsePlan(value: unknown): IslandPlan | undefined {
  if (!isRecord(value)) return undefined
  const plan = str(value.plan) ?? ''
  const overview = str(value.overview) ?? ''
  if (!plan && !overview) return undefined
  const todos = Array.isArray(value.todos)
    ? value.todos.flatMap((todo) => {
        if (!isRecord(todo)) return []
        const content = nonEmpty(todo.content)
        return content ? [{ id: str(todo.id) ?? content, content: capped(content) }] : []
      })
    : []
  const filepath = nonEmpty(value.filepath)
  const toolCallId = nonEmpty(value.toolCallId)
  return {
    name: capped(str(value.name) ?? 'Plan'),
    overview: capped(overview),
    plan: capped(plan),
    todos,
    ...(filepath ? { filepath } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  }
}

function parseSession(value: unknown): IslandSession | null {
  if (!isRecord(value)) return null
  const sessionId = nonEmpty(value.sessionId)
  const projectId = nonEmpty(value.projectId)
  if (!sessionId || !projectId) return null
  const status = ISLAND_STATUSES.includes(value.status as IslandStatus)
    ? (value.status as IslandStatus)
    : 'idle'
  const step = nonEmpty(value.step)
  const replyPreview = nonEmpty(value.replyPreview)
  const pending = parsePending(value.pending)
  const pendingPlan = parsePlan(value.pendingPlan)
  const lastActivityAt = typeof value.lastActivityAt === 'number' ? value.lastActivityAt : undefined
  return {
    sessionId,
    projectId,
    projectName: str(value.projectName) ?? '',
    title: str(value.title) ?? '',
    status,
    ...(step ? { step } : {}),
    ...(replyPreview ? { replyPreview } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(pending ? { pending } : {}),
    ...(pendingPlan ? { pendingPlan } : {}),
  }
}

export function parseIslandSnapshot(value: unknown): IslandSnapshot {
  if (!isRecord(value)) return { ...EMPTY_ISLAND_SNAPSHOT, updatedAt: Date.now() }
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map(parseSession).filter((s): s is IslandSession => s !== null)
    : []
  const recentProjects = Array.isArray(value.recentProjects)
    ? value.recentProjects.flatMap((project) => {
        if (!isRecord(project)) return []
        const projectId = nonEmpty(project.projectId)
        return projectId ? [{ projectId, name: str(project.name) ?? '' }] : []
      })
    : []
  const notice = nonEmpty(value.notice)
  const focusedSessionKey = nonEmpty(value.focusedSessionKey)
  const buddyLook = parseIslandBuddyLook(value.buddyLook)
  return {
    sessions,
    recentProjects,
    ...(focusedSessionKey ? { focusedSessionKey } : {}),
    ...(notice ? { notice } : {}),
    ...(buddyLook ? { buddyLook } : {}),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

export function parseIslandBuddyLook(value: unknown): IslandBuddyLook | undefined {
  if (!isRecord(value)) return undefined
  const { topper, face, bolts, blush } = value
  const tail = value.tail ?? 'none'
  const eyewear = value.eyewear ?? 'none'
  const neck = value.neck ?? 'none'
  if (!ISLAND_BUDDY_TOPPERS.includes(topper as IslandBuddyLook['topper'])) return undefined
  if (!ISLAND_BUDDY_FACES.includes(face as IslandBuddyLook['face'])) return undefined
  if (!ISLAND_BUDDY_TAILS.includes(tail as IslandBuddyLook['tail'])) return undefined
  if (!ISLAND_BUDDY_EYEWEAR.includes(eyewear as IslandBuddyLook['eyewear'])) return undefined
  if (!ISLAND_BUDDY_NECKS.includes(neck as IslandBuddyLook['neck'])) return undefined
  if (typeof bolts !== 'boolean' || typeof blush !== 'boolean') return undefined
  return {
    topper: topper as IslandBuddyLook['topper'],
    face: face as IslandBuddyLook['face'],
    tail: tail as IslandBuddyLook['tail'],
    eyewear: eyewear as IslandBuddyLook['eyewear'],
    neck: neck as IslandBuddyLook['neck'],
    bolts,
    blush,
  }
}

/** Merge per-window snapshots, most recently updated window first. Only the
 * focused window's `focusedSessionKey` survives, via `focusedWindowSnapshot`. */
export function mergeIslandSnapshots(
  snapshots: Iterable<IslandSnapshot>,
  focusedWindowSnapshot?: IslandSnapshot,
): IslandSnapshot {
  const ordered = [...snapshots].sort((a, b) => b.updatedAt - a.updatedAt)
  const seenSessions = new Set<string>()
  const seenProjects = new Set<string>()
  const merged: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }
  for (const snapshot of ordered) {
    merged.updatedAt = Math.max(merged.updatedAt, snapshot.updatedAt)
    if (!merged.notice && snapshot.notice) merged.notice = snapshot.notice
    if (!merged.buddyLook && snapshot.buddyLook) merged.buddyLook = snapshot.buddyLook
    for (const session of snapshot.sessions) {
      const key = islandSessionKey(session.projectId, session.sessionId)
      if (seenSessions.has(key)) continue
      seenSessions.add(key)
      merged.sessions.push(session)
    }
    for (const project of snapshot.recentProjects) {
      if (seenProjects.has(project.projectId)) continue
      seenProjects.add(project.projectId)
      merged.recentProjects.push(project)
    }
  }
  if (focusedWindowSnapshot?.focusedSessionKey) merged.focusedSessionKey = focusedWindowSnapshot.focusedSessionKey
  return merged
}

export interface PendingAutoExpandDecision {
  /** Request id that should pop the island open, if any. */
  expand: string | null
  /** Unseen request ids in the chat the user is already looking at; they
   * should be marked seen without expanding. */
  suppressed: string[]
}

/** Decides which unseen pending requests auto-expand the island. A request in
 * the session visible in a focused app window is suppressed: the user is
 * already looking at it. */
export function pendingRequestsToAutoExpand(
  snapshot: IslandSnapshot,
  seen: ReadonlySet<string>,
): PendingAutoExpandDecision {
  const decision: PendingAutoExpandDecision = { expand: null, suppressed: [] }
  for (const session of snapshot.sessions) {
    const id = session.pending?.request.id
    if (!id || seen.has(id)) continue
    if (islandSessionKey(session.projectId, session.sessionId) === snapshot.focusedSessionKey) {
      decision.suppressed.push(id)
    } else if (decision.expand === null) {
      decision.expand = id
    }
  }
  return decision
}

export type IslandConfigPatchResult =
  | { ok: true; patch: Partial<IslandConfig> }
  | { ok: false; error: string }

export function parseIslandConfigPatch(value: unknown): IslandConfigPatchResult {
  if (!isRecord(value)) return { ok: false, error: 'Invalid island settings' }
  const patch: Partial<IslandConfig> = {}
  for (const key of ['enabled', 'autoHide', 'sounds'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') return { ok: false, error: `"${key}" must be a boolean` }
    patch[key] = value[key] as boolean
  }
  if (value.shortcut !== undefined) {
    if (typeof value.shortcut !== 'string' || !value.shortcut.trim()) {
      return { ok: false, error: 'Shortcut cannot be empty' }
    }
    patch.shortcut = value.shortcut.trim()
  }
  if (value.soundVolume !== undefined) {
    const volume = value.soundVolume
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
      return { ok: false, error: '"soundVolume" must be between 0 and 1' }
    }
    patch.soundVolume = volume
  }
  return { ok: true, patch }
}
