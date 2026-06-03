// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-QUICKOPEN-PATH — surface the parent directory beneath each Quick
 * Open row, VS-Code-style.
 *
 * Pure, side-effect-free. Given the flat file list the palette will show,
 * decides:
 *
 *   • What to RENDER beneath the filename (`display`):
 *       - Parent directory is the default, matching VS Code's Quick
 *         Open where every row's description carries the relative path
 *         to its containing folder. ALWAYS shown when there is one.
 *       - Files literally AT the workspace root (no parent dir) drop to
 *         null — the filename already conveys the full path, no extra
 *         context to add.
 *       - When a root-level file SHARES its basename with a deeper
 *         file, we render the `(root)` sentinel so it doesn't look
 *         indistinguishable from the deeper one.
 *       - Multi-root workspaces prepend the root label so the user can
 *         tell which workspace folder a row belongs to.
 *
 *   • What to MATCH against (`searchText`) — always the full path (and
 *     root label, when multi-root). Typing `components/app` still finds
 *     `src/components/App.tsx` regardless of what we chose to render.
 *
 * The Palette consumer wires `display` to `PaletteItem.sublabel` (which
 * is both rendered AND searched as a secondary tier) and `searchText`
 * to `PaletteItem.searchText` (the tertiary, render-less search tier).
 * Both tiers share the same fzf-score penalty so an exact-tier-match
 * against either still beats a no-match.
 *
 * Implementation lives in this file (not inline in Workbench) so the
 * disambiguation rules — boundary cases at the FS root, multi-root
 * shape, backslash normalization, case-sensitive basename comparison —
 * can be pinned by unit tests without rendering React.
 */

/** A file row we want to surface in Quick Open. */
export interface QuickOpenFile {
  /** Unique key — typically `${rootId}::${path}`. Used as Map key. */
  id: string;
  /** Basename (what the row's primary text shows). */
  name: string;
  /** Path relative to the root the file lives under. */
  path: string;
  /**
   * Display label of the file's workspace root. Required when multi-root
   * is requested via opts.multiRoot; ignored otherwise.
   */
  rootLabel?: string;
}

export interface DisambiguationResult {
  /**
   * Full text to score fuzzy matches against — always populated. When
   * multi-root, prefixed with the root label so `agent/src/App.tsx`
   * works just as well as `src/App.tsx`. Never rendered directly.
   */
  searchText: string;
  /**
   * Text rendered beneath the filename. null = single-line row (no
   * sublabel). Default is the parent directory (always shown when the
   * file has one); null only when the file sits at the workspace root
   * AND its basename is unique. See module docstring for full rules.
   */
  display: string | null;
}

export interface DisambiguateOptions {
  /**
   * True when there's more than one workspace root open. Forces every
   * file to surface its root context, matching VS Code's multi-root
   * Quick Open behaviour where workspace folder is always shown.
   */
  multiRoot?: boolean;
}

/**
 * Normalise a path-ish string so we can extract a parent directory
 * irrespective of separator quirks:
 *   - Windows-style `\` → `/`
 *   - Trailing slashes stripped
 *   - Repeated slashes collapsed
 *
 * Returned string is suitable for both display (after parent extraction)
 * AND for inclusion in searchText.
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
}

/**
 * Extract the parent-directory portion of a path, or empty string when
 * the path is just a bare filename (file at the workspace root).
 *
 * Examples:
 *   "src/components/App.tsx" → "src/components"
 *   "App.tsx"                → ""
 *   "src\\App.tsx"           → "src"
 *   "/leading/slash/file.ts" → "/leading/slash"   (leading slash kept)
 *   ""                       → ""
 */
export function parentDirOf(path: string): string {
  const norm = normalizePath(path);
  const i = norm.lastIndexOf("/");
  if (i < 0) return "";
  return norm.slice(0, i);
}

/**
 * Sentinel rendered when a file at the workspace root shares its
 * basename with another file deeper in the tree. Without this, the
 * root-level entry would render no parent-dir hint at all and look
 * indistinguishable from the deeper file in the row UI.
 *
 * Wrapped in parens (not just empty) so the user reads it as a label,
 * not a missing field. Matches VS Code's behaviour of showing the
 * workspace-folder name even when the file is at the folder root.
 */
export const ROOT_PLACEHOLDER = "(root)";

/**
 * Build per-file disambiguation results for a Quick Open list.
 *
 * Algorithm:
 *   1. Count basenames across the input set (case-sensitive — see
 *      docstring for the case-comparison decision).
 *   2. For each file, decide `display`:
 *        - multi-root  → always rendered as `<rootLabel> · <parentDir>`
 *                        (or just `<rootLabel>` when at the root of its
 *                        own tree).
 *        - ambiguous   → render the parent dir (or ROOT_PLACEHOLDER).
 *        - else        → null (single-line row).
 *   3. `searchText` is always the full normalised path, prefixed with
 *      the root label when multi-root, so power users can still narrow
 *      by typing a directory fragment even when the basename is unique
 *      and the sublabel is hidden.
 *
 * Determinism:
 *   - Input order is preserved; output is a Map keyed by `id`. If two
 *     entries share an `id` the LAST one wins (caller's responsibility
 *     to dedupe upstream — flattenFiles in Workbench produces unique
 *     paths per root so this never happens in practice).
 *
 * Case sensitivity:
 *   - Basename comparison is exact-case. On case-insensitive file
 *     systems the IDE would never surface `Foo.tsx` and `foo.tsx` as
 *     separate files anyway, so we don't second-guess the input. On
 *     case-sensitive FS this matches the file system's own truth.
 */
export function buildDisambiguation(
  files: ReadonlyArray<QuickOpenFile>,
  opts: DisambiguateOptions = {},
): Map<string, DisambiguationResult> {
  // Pass 1: count basenames so we know which rows are ambiguous.
  const nameCounts = new Map<string, number>();
  for (const f of files) {
    nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);
  }

  // Pass 2: build the result map.
  const out = new Map<string, DisambiguationResult>();
  for (const f of files) {
    const parent = parentDirOf(f.path);
    const ambiguous = (nameCounts.get(f.name) ?? 0) > 1;

    // searchText: full path always; prefix root label when multi-root
    // so typing `agent/src/App` matches the same way `src/App` does.
    // Use normalisePath so separators agree with parentDirOf output.
    const normPath = normalizePath(f.path);
    const searchText = opts.multiRoot && f.rootLabel
      ? `${f.rootLabel}/${normPath}`
      : normPath;

    // display: VS-Code-style "always show parent dir when there is one".
    let display: string | null = null;
    if (opts.multiRoot) {
      // Compose "<rootLabel> · <parent>", gracefully omitting either
      // side when missing. Caller is supposed to populate rootLabel
      // whenever multiRoot is true, but a missing label must not
      // produce an ugly leading separator like " · src".
      const label = f.rootLabel ?? "";
      if (label && parent) display = `${label} · ${parent}`;
      else if (label) display = label;
      else if (parent) display = parent;
      else display = null;
    } else {
      // Single-root: parent dir is the default sublabel. Files literally
      // at the workspace root have no parent → drop to null (the
      // filename already conveys the full path). The lone exception is
      // a root-level file whose basename collides with a deeper file:
      // render ROOT_PLACEHOLDER so the row is visibly distinct from
      // the deeper collider it shares a name with.
      if (parent) display = parent;
      else if (ambiguous) display = ROOT_PLACEHOLDER;
      else display = null;
    }

    out.set(f.id, { searchText, display });
  }
  return out;
}
