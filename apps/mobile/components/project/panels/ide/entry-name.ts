// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Validation for names typed into the explorer's inline "new file / folder /
// rename" input. Mirrors VS Code: names are single path segments, can't
// collide with a sibling, and (for rename) selecting the text leaves the
// extension out so typing replaces just the base name.

export interface ValidateEntryNameOptions {
  /** Names of the entries that share the parent directory. */
  siblings: readonly string[];
  /** When renaming, the current name — allowed to match itself (incl. case-only changes). */
  currentName?: string;
}

/**
 * Returns a user-facing error, or null when the name is acceptable.
 * An empty/whitespace name returns null: callers treat that as "cancel".
 */
export function validateEntryName(raw: string, opts: ValidateEntryNameOptions): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (/[\\/]/.test(name)) {
    return "A file or folder name cannot contain \"/\" or \"\\\".";
  }
  if (name === "." || name === "..") {
    return `"${name}" is not a valid file or folder name.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) {
    return "A file or folder name cannot contain control characters.";
  }
  if (name.length > 255) {
    return "That name is too long.";
  }
  const lower = name.toLowerCase();
  for (const sib of opts.siblings) {
    if (opts.currentName !== undefined && sib === opts.currentName) continue;
    // Case-insensitive so a clash is caught on macOS/Windows filesystems too.
    if (sib.toLowerCase() === lower) {
      return `A file or folder named "${name}" already exists here.`;
    }
  }
  return null;
}

/**
 * End offset of the text to pre-select when starting a rename: the base name
 * without its extension for files (`foo.test.ts` -> `foo.test`), the whole
 * name for folders and dotfiles (`.env`, `.gitignore`).
 */
export function renameSelectionEnd(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}
