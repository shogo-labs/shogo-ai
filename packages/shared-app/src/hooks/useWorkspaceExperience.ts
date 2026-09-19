// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single source of truth for "what does the personal vs. team workspace
 * shell look like?" — a pure descriptor derived from `Workspace.kind`.
 *
 * Before this existed, every surface (sidebar, bottom nav, home route,
 * activity route, chat composer) re-derived its own answer with an ad-hoc
 * `workspace?.kind === 'personal'` check. That meant a new personal-only
 * surface (or a change to what personal hides) required finding and
 * updating N call sites, and it was easy for one to drift (see
 * `apps/mobile/app/(app)/settings.tsx`'s slug/name heuristic instead of
 * `kind`, found while writing this).
 *
 * `workspaceExperience()` is the one function that maps a workspace `kind`
 * to every UI capability that varies by it. `useWorkspaceExperience()`
 * (in the mobile app, where the active workspace hook lives) is the
 * thin wrapper every component should call instead of reading `kind`
 * directly.
 *
 * Personal is a SUBSET of team: every field here removes/replaces a team
 * capability, there are no personal-only additions modeled as booleans
 * (goal/activity nav are the one exception, since personal's home surface
 * genuinely adds nav the team shell doesn't have).
 */

export type WorkspaceExperienceKind = 'personal' | 'team'

export type BottomTabId = 'chat' | 'goals' | 'activity' | 'tasks' | 'canvases'

export interface WorkspaceExperienceComposer {
  /** Show the model picker control in ChatInput. */
  showModelPicker: boolean
  /** Show the interaction-mode (plan/agent/chat) selector and its Tab/Shift+Tab cycling in ChatInput. */
  showInteractionModes: boolean
  /** When interaction modes are hidden, the mode ChatPanel should force. */
  forcedMode?: 'agent'
}

export interface WorkspaceExperience {
  kind: WorkspaceExperienceKind
  /** Which top-level shell the app's home route should render. */
  homeScreen: 'companion' | 'builder'
  /** Sidebar: show the pinned/filtered projects tree. */
  showProjectsTree: boolean
  /** Sidebar: show the Marketplace nav item. */
  showMarketplace: boolean
  /** Sidebar (native drawer): show the New Chat nav item. */
  showNewChat: boolean
  /** Sidebar: show Goals/Activity nav items. */
  showGoalsNav: boolean
  /**
   * Sidebar / profile sheet: show a "Side chats" entry — secondary
   * workspace-scoped chat sessions (`ChatSession.isPrimary === false`)
   * for exploring a tangent without polluting the goal-tracking primary
   * thread. Personal-only: team workspaces already expose every chat
   * session through the projects tree.
   */
  showSideChatsNav: boolean
  /** Bottom tab bar item ids, in display order. */
  bottomTabs: BottomTabId[]
  /**
   * Whether tapping the Chat tab should restore the last active project's
   * chat (team) or always return to the workspace's primary/home chat
   * (personal, which has no project context to return to).
   */
  chatReturnsToProjectContext: boolean
  composer: WorkspaceExperienceComposer
}

/**
 * Derive the experience descriptor from a workspace's `kind`. Accepts
 * `null`/`undefined` (workspace not loaded yet) and treats anything other
 * than the literal `'personal'` as `'team'` — the same fail-safe default
 * `normalizeWorkspaceKind` uses server-side, so an unloaded or malformed
 * workspace never accidentally gets the more-privileged team surface hidden
 * or, worse, the personal capability restrictions silently lifted.
 */
export function workspaceExperience(
  kind: WorkspaceExperienceKind | string | null | undefined,
): WorkspaceExperience {
  const isPersonal = kind === 'personal'
  return {
    kind: isPersonal ? 'personal' : 'team',
    homeScreen: isPersonal ? 'companion' : 'builder',
    showProjectsTree: !isPersonal,
    showMarketplace: !isPersonal,
    showNewChat: !isPersonal,
    showGoalsNav: isPersonal,
    showSideChatsNav: isPersonal,
    bottomTabs: isPersonal
      ? ['chat', 'goals', 'activity']
      : ['chat', 'tasks', 'activity', 'canvases'],
    chatReturnsToProjectContext: !isPersonal,
    composer: {
      showModelPicker: !isPersonal,
      showInteractionModes: !isPersonal,
      forcedMode: isPersonal ? 'agent' : undefined,
    },
  }
}
