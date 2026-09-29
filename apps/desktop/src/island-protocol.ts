// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Wire types shared by the island main process, its preload, and its
// renderer. The app renderer (apps/mobile/lib/desktop-island.ts) mirrors the
// snapshot and action shapes; everything crossing IPC is re-validated here.

export const ISLAND_MODES = ['hidden', 'collapsed', 'expanded', 'compose'] as const
export type IslandMode = (typeof ISLAND_MODES)[number]

export type IslandStatus = 'idle' | 'running' | 'done' | 'needs_approval' | 'needs_answer'
const ISLAND_STATUSES: readonly IslandStatus[] = ['idle', 'running', 'done', 'needs_approval', 'needs_answer']

export type IslandPermissionDecision = 'allow_once' | 'always_allow' | 'deny'
const ISLAND_DECISIONS: readonly IslandPermissionDecision[] = ['allow_once', 'always_allow', 'deny']

export interface IslandPermissionRequest {
  id: string
  toolName: string
  reason: string
  params: Record<string, unknown>
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

export interface IslandSession {
  sessionId: string
  projectId: string
  projectName: string
  title: string
  status: IslandStatus
  step?: string
  replyPreview?: string
  pending?: IslandPending
}

export interface IslandProject {
  projectId: string
  name: string
}

export interface IslandSnapshot {
  sessions: IslandSession[]
  recentProjects: IslandProject[]
  notice?: string
  updatedAt: number
}

export const EMPTY_ISLAND_SNAPSHOT: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }

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

type IslandActionBase =
  | { type: 'open'; projectId: string; sessionId: string }
  | { type: 'permission'; requestId: string; decision: IslandPermissionDecision; pattern?: string }
  | { type: 'question'; requestId: string; response: string }

/** Island renderer -> main process. */
export type IslandAction =
  | IslandActionBase
  | { type: 'send'; target: IslandTarget; text: string; files?: IslandFileRef[] }

/** Main process -> app renderer. */
export type IslandAppAction =
  | IslandActionBase
  | { type: 'send'; target: IslandTarget; text: string; files?: IslandAttachment[] }

export type IslandActionResult = { ok: true } | { ok: false; error: string }

export interface IslandLayout {
  mode: IslandMode
  notched: boolean
}

/** Exposed to the island renderer as `window.shogoIsland`. */
export interface IslandBridge {
  onSnapshot(callback: (snapshot: IslandSnapshot) => void): void
  onLayout(callback: (layout: IslandLayout) => void): void
  onOpenCompose(callback: () => void): void
  sendAction(action: IslandAction): Promise<IslandActionResult>
  setMode(mode: IslandMode): void
  setInteractive(interactive: boolean): void
  getPathForFile(file: File): string
}

export interface IslandConfig {
  enabled: boolean
  autoHide: boolean
  shortcut: string
}

export const DEFAULT_ISLAND_SHORTCUT = 'CommandOrControl+Shift+Space'

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

function parseTarget(value: unknown): IslandTarget | null {
  if (!isRecord(value)) return null
  const projectId = nonEmpty(value.projectId)
  if (!projectId) return null
  if (value.kind === 'new') return { kind: 'new', projectId }
  const sessionId = nonEmpty(value.sessionId)
  if (value.kind === 'session' && sessionId) return { kind: 'session', projectId, sessionId }
  return null
}

function parseFileRef(value: unknown): IslandFileRef | null {
  if (!isRecord(value)) return null
  const path = nonEmpty(value.path)
  const name = nonEmpty(value.name)
  if (!path || !name) return null
  return { path, name, type: str(value.type) ?? '' }
}

export function parseIslandAction(value: unknown): IslandAction | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'open': {
      const projectId = nonEmpty(value.projectId)
      const sessionId = nonEmpty(value.sessionId)
      return projectId && sessionId ? { type: 'open', projectId, sessionId } : null
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
    case 'send': {
      const target = parseTarget(value.target)
      const text = str(value.text) ?? ''
      if (!target) return null
      let files: IslandFileRef[] | undefined
      if (value.files !== undefined) {
        if (!Array.isArray(value.files)) return null
        files = []
        for (const raw of value.files) {
          const file = parseFileRef(raw)
          if (!file) return null
          files.push(file)
        }
      }
      if (!text.trim() && !files?.length) return null
      return { type: 'send', target, text, ...(files?.length ? { files } : {}) }
    }
    default:
      return null
  }
}

function parsePending(value: unknown): IslandPending | undefined {
  if (!isRecord(value) || !isRecord(value.request)) return undefined
  const request = value.request
  const id = nonEmpty(request.id)
  if (!id) return undefined
  if (value.kind === 'permission') {
    return {
      kind: 'permission',
      request: {
        id,
        toolName: str(request.toolName) ?? '',
        reason: str(request.reason) ?? '',
        params: isRecord(request.params) ? request.params : {},
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
  return {
    sessionId,
    projectId,
    projectName: str(value.projectName) ?? '',
    title: str(value.title) ?? '',
    status,
    ...(step ? { step } : {}),
    ...(replyPreview ? { replyPreview } : {}),
    ...(pending ? { pending } : {}),
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
  return {
    sessions,
    recentProjects,
    ...(notice ? { notice } : {}),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

/** Merge per-window snapshots, most recently updated window first. */
export function mergeIslandSnapshots(snapshots: Iterable<IslandSnapshot>): IslandSnapshot {
  const ordered = [...snapshots].sort((a, b) => b.updatedAt - a.updatedAt)
  const seenSessions = new Set<string>()
  const seenProjects = new Set<string>()
  const merged: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }
  for (const snapshot of ordered) {
    merged.updatedAt = Math.max(merged.updatedAt, snapshot.updatedAt)
    if (!merged.notice && snapshot.notice) merged.notice = snapshot.notice
    for (const session of snapshot.sessions) {
      const key = `${session.projectId}:${session.sessionId}`
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
  return merged
}

export type IslandConfigPatchResult =
  | { ok: true; patch: Partial<IslandConfig> }
  | { ok: false; error: string }

export function parseIslandConfigPatch(value: unknown): IslandConfigPatchResult {
  if (!isRecord(value)) return { ok: false, error: 'Invalid island settings' }
  const patch: Partial<IslandConfig> = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '"enabled" must be a boolean' }
    patch.enabled = value.enabled
  }
  if (value.autoHide !== undefined) {
    if (typeof value.autoHide !== 'boolean') return { ok: false, error: '"autoHide" must be a boolean' }
    patch.autoHide = value.autoHide
  }
  if (value.shortcut !== undefined) {
    if (typeof value.shortcut !== 'string' || !value.shortcut.trim()) {
      return { ok: false, error: 'Shortcut cannot be empty' }
    }
    patch.shortcut = value.shortcut.trim()
  }
  return { ok: true, patch }
}
