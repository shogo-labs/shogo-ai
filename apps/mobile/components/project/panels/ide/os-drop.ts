// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * os-drop.ts — the pure half of "drag a file (or a folder) from your computer
 * into the IDE and have it upload" (SHO-215).
 *
 * Three jobs, all free of React state so they can be unit-tested directly:
 *
 *   1. `isOsFileDrag` — tell an OS file drag apart from the IDE's own in-app
 *      drags (tree rows, editor tabs). Those must keep their move/split
 *      behaviour; only real OS drags may upload.
 *
 *   2. `collectDroppedEntries` — turn a `DataTransfer` into `{ path, file }`
 *      pairs, walking dropped folders recursively so `docs/sub/a.md`
 *      recreates the structure instead of being skipped (the pre-SHO-215
 *      helper dropped every `isDirectory` entry on the floor).
 *
 *   3. `resolveDropTarget` — map the element under the pointer to the folder
 *      the drop belongs in: a folder row → that folder, a file row → its
 *      parent folder, anything else (empty sidebar, editor, tabs, panel) →
 *      `null`, which the caller reads as "the workspace root".
 */

/** The `dataTransfer` type in-app tree/tab drags carry. */
export const IDE_DRAG_TYPE = "application/x-ide-path";

/** One file from the drop, with its path relative to the drop destination. */
export interface DroppedEntry {
  /** Forward-slashed, relative to the destination folder, e.g. `docs/a.md`. */
  path: string;
  file: File;
}

/** Folder a drop lands in. `path` is relative to `rootId`; `""` = the root. */
export interface DropDestination {
  rootId: string;
  path: string;
}

/** Directory that contains `path` ("" for a top-level entry). */
export function parentDirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function dragTypes(dt: DataTransfer | null | undefined): string[] {
  return Array.from(dt?.types ?? []);
}

/**
 * True when the drag carries files from outside the app. In-app drags are
 * excluded by their marker type, so a tree row dropped on a folder still
 * moves and an editor tab still splits.
 */
export function isOsFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = dragTypes(dt);
  if (!types.includes("Files")) return false;
  return !types.includes(IDE_DRAG_TYPE);
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedEntry[],
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    out.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // `readEntries` yields at most 100 entries per call, so keep asking until
  // it returns an empty batch.
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, path, out);
  }
}

/**
 * Every file in the drop, folders walked recursively.
 *
 * All `DataTransfer` reads happen synchronously before the first `await` —
 * the items are neutered as soon as the drop handler returns.
 */
export async function collectDroppedEntries(dt: DataTransfer): Promise<DroppedEntry[]> {
  const items = Array.from(dt.items ?? []);
  const entries: FileSystemEntry[] = [];
  const loose: DroppedEntry[] = [];

  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) {
      entries.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file) loose.push({ path: file.name, file });
  }

  if (entries.length === 0 && loose.length === 0) {
    return Array.from(dt.files ?? []).map((file) => ({ path: file.name, file }));
  }

  const out: DroppedEntry[] = [];
  for (const entry of entries) {
    try {
      await walkEntry(entry, "", out);
    } catch {
      // A folder we can't enumerate (permissions, a drive that vanished)
      // must not sink the rest of the drop.
    }
  }
  // `webkitGetAsEntry` can be present but useless (old Firefox); fall back to
  // the flat file list rather than uploading nothing.
  if (out.length === 0 && entries.length > 0 && (dt.files?.length ?? 0) > 0) {
    return Array.from(dt.files).map((file) => ({ path: file.name, file }));
  }
  return [...out, ...loose];
}

/**
 * Folder the drop belongs in, resolved from the element under the pointer.
 * `null` = not over a tree row → the workspace root.
 */
export function resolveDropTarget(target: Element | null): DropDestination | null {
  const row = target?.closest?.("[data-tree-path]") ?? null;
  if (!row) return null;
  const rootId = row.getAttribute("data-tree-root");
  if (!rootId) return null;
  const path = row.getAttribute("data-tree-path") ?? "";
  const kind = row.getAttribute("data-tree-kind");
  return { rootId, path: kind === "file" ? parentDirOf(path) : path };
}
