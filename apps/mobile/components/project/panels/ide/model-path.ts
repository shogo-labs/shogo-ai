// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * @monaco-editor/react encodes the `path` prop into the model URI's path.
 * Our workbench uses `pathKey = "<rootId>::<relPath>"`, so strip any leading
 * slash and split on `::` to recover the pieces.
 */
export function pathFromUri(uri: { path?: string }): { path: string; rootId: string | null } {
  let raw = uri.path ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* leave raw as-is */
  }
  raw = raw.replace(/^\/+/, "");
  const idx = raw.indexOf("::");
  if (idx === -1) return { path: raw, rootId: null };
  return { rootId: raw.slice(0, idx), path: raw.slice(idx + 2) };
}
