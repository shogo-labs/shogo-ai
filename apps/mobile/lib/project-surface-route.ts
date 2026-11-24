// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one builder for a standalone project surface (canvas, files, plans,
 * settings) — `/(app)/project-surface/[id]`.
 *
 * Two places open a surface from outside the project screen: the project tab
 * bar in `MobileBottomNav` and the quick buttons on an agent's chat list
 * (`/(app)/project-chats`). They must send the same params, or a surface opened
 * from one reads differently from the other (the tab bar lights its tab from
 * `navTab`), so the route is built here once.
 */

export type ProjectSurface = "canvas" | "files" | "plans" | "settings"

export interface ProjectSurfaceRoute {
  pathname: "/(app)/project-surface/[id]"
  params: {
    id: string
    surface: ProjectSurface
    navTab: ProjectSurface
    /** Kept so a surface opened from a chat can hand that chat back. */
    chatSessionId?: string
  }
}

/**
 * Push/replace this with `router` to open `surface` for `projectId`. `push`
 * (not `replace`) from a screen the viewer should get back to with Back.
 */
export function projectSurfaceRoute(
  projectId: string,
  surface: ProjectSurface,
  options: { chatSessionId?: string | null } = {},
): ProjectSurfaceRoute {
  return {
    pathname: "/(app)/project-surface/[id]",
    params: {
      id: projectId,
      surface,
      navTab: surface,
      ...(options.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
    },
  }
}
