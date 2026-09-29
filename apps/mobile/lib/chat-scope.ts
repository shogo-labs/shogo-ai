// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which backend a chat surface talks to: the per-project chat
 * (`/api/projects/:id/chat`) or a workspace session
 * (`/api/workspaces/:id/chat`, optionally pinned to a project).
 *
 * The cloud vs local split lives here instead of inline in each screen:
 * the project-pinned workspace session endpoints are under
 * `/api/local/projects`, which only the local API mounts, so project tabs
 * must stay project-scoped in cloud builds. Getting this wrong in one
 * screen was the most repeated post-2.0 chat bug.
 */
import {
  isProjectWorkspaceRuntimeEnabled,
  isWorkspaceRuntimeEnabled,
} from './platform-config'

export type ChatScope = 'project' | 'workspace'

export interface ChatScopeEnv {
  /** Workspace sessions exist at all (home drafts, side chats). */
  workspaceRuntimeEnabled: boolean
  /** Project tabs route through the project-pinned workspace session. */
  projectWorkspaceRuntimeEnabled: boolean
}

export type ChatScopeSurface =
  /** Draft chat created from the home composer for a new project. */
  | { surface: 'home-draft' }
  /** A chat tab on the project page. */
  | { surface: 'project-tab'; isInitialSession: boolean; requestedScope: ChatScope }
  /** The standalone project chat route (`/project-chat/[id]`). */
  | { surface: 'project-chat'; requestedScope: ChatScope }

export function currentChatScopeEnv(): ChatScopeEnv {
  return {
    workspaceRuntimeEnabled: isWorkspaceRuntimeEnabled(),
    projectWorkspaceRuntimeEnabled: isProjectWorkspaceRuntimeEnabled(),
  }
}

export function resolveChatScope(
  input: ChatScopeSurface,
  env: ChatScopeEnv = currentChatScopeEnv(),
): ChatScope {
  switch (input.surface) {
    case 'home-draft':
      return env.workspaceRuntimeEnabled ? 'workspace' : 'project'
    case 'project-tab':
      if (env.projectWorkspaceRuntimeEnabled) return 'workspace'
      // Only the tab that received a workspace draft hand-off keeps it; tabs
      // opened later are ordinary project chats.
      if (input.isInitialSession && env.workspaceRuntimeEnabled) return input.requestedScope
      return 'project'
    case 'project-chat':
      return env.workspaceRuntimeEnabled ? input.requestedScope : 'project'
  }
}
