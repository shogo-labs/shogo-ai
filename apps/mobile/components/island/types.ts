// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Island-window side of the desktop island protocol. Mirrors
// apps/desktop/src/island-protocol.ts; the main process re-validates every
// action sent from here.

import type {
  DesktopIslandSession,
  DesktopIslandSnapshot,
  IslandPermissionDecision,
} from "../../lib/desktop-island"

export type IslandMode = "hidden" | "collapsed" | "expanded" | "compose"

export type IslandSession = DesktopIslandSession
export type IslandSnapshot = DesktopIslandSnapshot

export interface IslandLayout {
  mode: IslandMode
  notched: boolean
  topInset: number
  sounds: boolean
  soundVolume: number
}

export interface IslandFileRef {
  path: string
  name: string
  type: string
}

export interface IslandAttachment {
  dataUrl: string
  name: string
  type: string
}

export type IslandTarget =
  | { kind: "session"; projectId: string; sessionId: string }
  | { kind: "new"; projectId: string }

export type IslandMeetingDecision = "record" | "always" | "dismiss" | "stop"

export interface IslandMeetingState {
  prompt?: { id: string; app: string; detectedAt: number; suggestAutoRecord: boolean }
  recording?: { id: string; startedAt: number; app?: string }
  busy?: boolean
  error?: string
}

export const EMPTY_ISLAND_MEETING_STATE: IslandMeetingState = {}

export type IslandAction =
  | { type: "open"; projectId: string; sessionId: string }
  | { type: "permission"; requestId: string; decision: IslandPermissionDecision; pattern?: string }
  | { type: "question"; requestId: string; response: string }
  | { type: "stop"; projectId: string; sessionId: string }
  | {
      type: "plan"
      projectId: string
      sessionId: string
      decision: "build" | "feedback"
      modelId?: string
      text?: string
    }
  | { type: "navigate"; path: string }
  | { type: "show-app" }
  | { type: "send"; target: IslandTarget; text: string; files?: IslandFileRef[] }
  | { type: "meeting"; decision: IslandMeetingDecision; promptId?: string }

export type IslandResult = { ok: true } | { ok: false; error: string }
export type IslandReadFilesResult = { ok: true; attachments: IslandAttachment[] } | { ok: false; error: string }

export interface IslandBridge {
  onSnapshot(callback: (snapshot: IslandSnapshot) => void): () => void
  onLayout(callback: (layout: IslandLayout) => void): () => void
  onOpenCompose(callback: () => void): () => void
  /** Missing on desktop builds that predate meeting prompts. */
  onMeeting?(callback: (state: IslandMeetingState) => void): () => void
  requestState(): void
  sendAction(action: IslandAction): Promise<IslandResult>
  readFiles(files: IslandFileRef[]): Promise<IslandReadFilesResult>
  setMode(mode: IslandMode): void
  setInteractive(interactive: boolean): void
  setContentHeight(height: number): void
  getPathForFile(file: File): string
}

export const EMPTY_ISLAND_SNAPSHOT: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }

export const DEFAULT_ISLAND_LAYOUT: IslandLayout = {
  mode: "hidden",
  notched: false,
  topInset: 0,
  sounds: true,
  soundVolume: 0.6,
}

export function getIslandBridge(): IslandBridge | null {
  if (typeof window === "undefined") return null
  return (window as unknown as { shogoIsland?: IslandBridge }).shogoIsland ?? null
}

/** True inside the desktop island overlay window. */
export function isIslandWindow(): boolean {
  return getIslandBridge() !== null
}

/** Spread onto a View/Pressable: react-native-web renders `dataSet` as
 * `data-*` attributes, which useIslandPointer hit-tests. RN's types don't
 * declare `dataSet`, hence the cast. */
export const ISLAND_SURFACE_PROPS = { dataSet: { islandSurface: "true" } } as object
export const ISLAND_TRIGGER_PROPS = {
  dataSet: { islandSurface: "true", islandTrigger: "true" },
} as object

export function islandSessionKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`
}
