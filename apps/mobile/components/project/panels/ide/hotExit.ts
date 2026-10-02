// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// "Hot exit": unsaved edits survive a reload / crash / accidental tab close.
// Dirty buffers of the project's own workspace are mirrored to localStorage
// (size-capped) together with the on-disk content they were based on, and are
// re-applied on the next session restore ONLY if the file on disk is still
// exactly that base — otherwise the file changed underneath us and silently
// resurrecting stale edits would overwrite newer work.

import type { EditorGroup, OpenFile } from "./types";

export interface DirtyBuffer {
  path: string;
  content: string;
  /** On-disk content the edit was made against. */
  base: string;
}

const MAX_FILE_CHARS = 400_000;
const MAX_TOTAL_CHARS = 1_500_000;
const AGENT_ROOT = "agent";

export const hotExitKey = (projectId: string | null | undefined) => `shogo.ide.dirty.${projectId || "default"}`;

export function snapshotDirty(groups: EditorGroup[]): DirtyBuffer[] {
  const out: DirtyBuffer[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const g of groups) {
    for (const f of g.files) {
      if (f.rootId !== AGENT_ROOT || !f.dirty || f.loading || f.error || f.extensionDetail || f.gitDiff) continue;
      if (seen.has(f.path)) continue;
      const size = f.content.length + f.savedContent.length;
      if (f.content.length > MAX_FILE_CHARS || total + size > MAX_TOTAL_CHARS) continue;
      seen.add(f.path);
      total += size;
      out.push({ path: f.path, content: f.content, base: f.savedContent });
    }
  }
  return out;
}

export function parseDirty(raw: string | null): DirtyBuffer[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (b): b is DirtyBuffer =>
        typeof b?.path === "string" && typeof b?.content === "string" && typeof b?.base === "string",
    );
  } catch {
    return [];
  }
}

/** Re-apply buffers whose base still matches disk. Returns the new list + how many were restored. */
export function applyDirty(files: OpenFile[], buffers: DirtyBuffer[]): { files: OpenFile[]; restored: number } {
  if (buffers.length === 0) return { files, restored: 0 };
  const byPath = new Map(buffers.map((b) => [b.path, b]));
  let restored = 0;
  const next = files.map((f) => {
    const b = byPath.get(f.path);
    if (!b || f.rootId !== AGENT_ROOT || f.error || f.loading) return f;
    if (f.savedContent !== b.base || f.content === b.content) return f;
    restored++;
    return { ...f, content: b.content, dirty: true };
  });
  return { files: next, restored };
}

export function loadDirty(projectId: string | null | undefined): DirtyBuffer[] {
  try {
    return parseDirty(localStorage.getItem(hotExitKey(projectId)));
  } catch {
    return [];
  }
}

export function saveDirty(projectId: string | null | undefined, buffers: DirtyBuffer[]): void {
  try {
    if (buffers.length === 0) localStorage.removeItem(hotExitKey(projectId));
    else localStorage.setItem(hotExitKey(projectId), JSON.stringify(buffers));
  } catch {
    /* quota — drop silently, the beforeunload prompt is still the safety net */
  }
}
