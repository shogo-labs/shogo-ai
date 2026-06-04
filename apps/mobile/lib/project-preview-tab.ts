// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Landing-tab policy for the project screen, extracted as a pure function so
 * the sidebar (and tests) can decide where a project-name click should land
 * without duplicating the inline logic in `projects/[id]/_layout.tsx`.
 *
 * Tabs:
 *   - `canvas`          — canvas-capable managed projects (visual builder)
 *   - `chat-fullscreen` — chat-only managed agents (canvas disabled)
 *   - `external-preview`— folder-linked / IDE-style projects (workingMode=external)
 *
 * There is no `kind`/`isChatOnly` field on Project; "chat-only" is inferred
 * from `settings.canvasEnabled === false` / `settings.activeMode === 'none'`,
 * and folder-linked from `workingMode === 'external'` (mirrors `_layout.tsx`).
 */
export type PreviewTabId = 'canvas' | 'chat-fullscreen' | 'external-preview'

export interface ProjectTabInput {
  workingMode?: string | null
  settings?: string | Record<string, unknown> | null
}

function parseSettings(settings: ProjectTabInput['settings']): Record<string, unknown> {
  if (!settings) return {}
  if (typeof settings === 'string') {
    try {
      return JSON.parse(settings || '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return settings
}

export function defaultTabForProject(project: ProjectTabInput): PreviewTabId {
  const s = parseSettings(project?.settings)
  const isExternal = (project?.workingMode ?? 'managed') === 'external'
  const canvasEnabled = s.canvasEnabled !== false
  // Legacy 'app' mode collapses to 'none' (chat) — same normalization as the
  // project layout (`_layout.tsx`).
  const rawMode = (s.activeMode as 'canvas' | 'app' | 'none' | undefined) ??
    (canvasEnabled ? 'canvas' : 'none')
  const activeMode = rawMode === 'app' ? 'none' : rawMode

  // Folder-linked projects open as a chat-only IDE whose dev server is shown
  // in the external preview pane.
  if (isExternal) return 'external-preview'
  // Chat-only managed agents land directly in fullscreen chat.
  if (!canvasEnabled || activeMode === 'none') return 'chat-fullscreen'
  // Canvas-capable builders land on the canvas.
  return 'canvas'
}
