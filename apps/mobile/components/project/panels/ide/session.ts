// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Editor session persistence: which tabs were open in which group, so a page
// reload / app restart reopens the IDE where the user left it. Only paths are
// stored (content is re-read from disk), so there is nothing stale to
// overwrite and no secrets land in localStorage.

import type { EditorGroup } from "./types";

export interface IdeSession {
  v: 1;
  groups: Array<{
    files: Array<{ rootId: string; path: string; pinned?: boolean }>;
    /** `${rootId}::${path}` of the group's active tab. */
    activeId: string | null;
  }>;
  activeGroupIdx: number;
}

const MAX_TABS = 40;
/** Only the project's own workspace is restorable: local-folder handles aren't persisted. */
const RESTORABLE_ROOT = "agent";

export const sessionStorageKey = (projectId: string | null | undefined) =>
  `shogo.ide.session.${projectId || "default"}`;

export function snapshotSession(groups: EditorGroup[], activeGroupIdx: number): IdeSession {
  let budget = MAX_TABS;
  return {
    v: 1,
    groups: groups.map((g) => {
      const files = g.files
        .filter((f) => f.rootId === RESTORABLE_ROOT && !f.extensionDetail && !f.error)
        .slice(0, Math.max(0, budget))
        .map((f) => ({ rootId: f.rootId, path: f.path, ...(f.pinned ? { pinned: true } : {}) }));
      budget -= files.length;
      return { files, activeId: g.activeId };
    }),
    activeGroupIdx,
  };
}

export function sessionHasTabs(s: IdeSession | null): s is IdeSession {
  return !!s && s.groups.some((g) => g.files.length > 0);
}

export function parseSession(raw: string | null): IdeSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<IdeSession>;
    if (v?.v !== 1 || !Array.isArray(v.groups)) return null;
    const groups = v.groups.slice(0, 2).map((g) => ({
      files: (Array.isArray(g?.files) ? g.files : [])
        .filter((f) => typeof f?.path === "string" && typeof f?.rootId === "string" && f.rootId === RESTORABLE_ROOT)
        .slice(0, MAX_TABS)
        .map((f) => ({ rootId: f.rootId, path: f.path, ...(f.pinned ? { pinned: true } : {}) })),
      activeId: typeof g?.activeId === "string" ? g.activeId : null,
    }));
    if (groups.length === 0) return null;
    const idx = typeof v.activeGroupIdx === "number" ? v.activeGroupIdx : 0;
    return { v: 1, groups, activeGroupIdx: Math.min(Math.max(0, idx), groups.length - 1) };
  } catch {
    return null;
  }
}

export function loadSession(projectId: string | null | undefined): IdeSession | null {
  try {
    return parseSession(localStorage.getItem(sessionStorageKey(projectId)));
  } catch {
    return null;
  }
}

export function saveSession(projectId: string | null | undefined, s: IdeSession): void {
  try {
    localStorage.setItem(sessionStorageKey(projectId), JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}
