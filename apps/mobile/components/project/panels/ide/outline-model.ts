// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * outline-model.ts — pure transforms for the Outline view (FEAT-OUTLINE).
 *
 * VS Code parity: the Explorer "Outline" view shows the document-symbol tree
 * for the active editor, with a live filter box and a sort toggle
 * (position / name / kind), and follows the cursor by highlighting the
 * symbol the caret currently sits in.
 *
 * This module owns every bit of that behaviour that does NOT touch Monaco,
 * React, or the network, so it can be unit-tested in isolation:
 *
 *   - normalize Monaco's hierarchical DocumentSymbol[] into a stable
 *     OutlineNode tree with deterministic ids + depth (buildOutline)
 *   - filter by substring, keeping ancestors of any match (filterOutline)
 *   - sort recursively + stably by position / name / kind (sortOutline)
 *   - flatten to the visible row list honouring collapse state (flattenVisible)
 *   - resolve the deepest symbol containing a cursor line (findActiveSymbolId)
 *   - map a (Monaco-numeric) SymbolKind to a human label (symbolKindLabel)
 *
 * Coordinate convention: ranges are Monaco IRange-style (1-indexed
 * startLineNumber/startColumn/endLineNumber/endColumn). We only depend on
 * the line/column *numbers*, never on a live Monaco instance, so the input
 * is a structural subset — Monaco's real `DocumentSymbol` satisfies it.
 */

/** Monaco IRange subset — 1-indexed, end-inclusive lines. */
export interface OutlineRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Structural subset of Monaco's `languages.DocumentSymbol`. The real type
 * is assignable to this (it has extra `tags`/`detail` we don't require),
 * so callers pass Monaco symbols straight through.
 */
export interface DocumentSymbolLike {
  name: string;
  detail?: string;
  kind: number;
  range: OutlineRange;
  selectionRange: OutlineRange;
  children?: DocumentSymbolLike[];
}

/** Normalized, id-stamped tree node the Outline UI renders. */
export interface OutlineNode {
  /** Stable id: parent path + index + name + start line. Survives re-sort. */
  id: string;
  name: string;
  detail: string;
  kind: number;
  /** Depth from root (0-based) — drives indentation. */
  depth: number;
  /** Full symbol range (used for cursor-follow containment). */
  range: OutlineRange;
  /** Where to put the caret when the row is clicked (the name token). */
  selectionRange: OutlineRange;
  children: OutlineNode[];
}

/** A single rendered row after collapse state is applied. */
export interface FlatOutlineRow {
  node: OutlineNode;
  /** True when the node has children (renders a twistie). */
  hasChildren: boolean;
  /** True when the node is collapsed (children hidden). */
  collapsed: boolean;
}

export type OutlineSortMode = "position" | "name" | "kind";

export const OUTLINE_SORT_MODES: readonly OutlineSortMode[] = [
  "position",
  "name",
  "kind",
] as const;

export const OUTLINE_SORT_LABELS: Record<OutlineSortMode, string> = {
  position: "Sort by Position",
  name: "Sort by Name",
  kind: "Sort by Category",
};

/**
 * Monaco `languages.SymbolKind` is a 0-indexed enum. We keep our own label
 * map rather than importing Monaco so this module stays runtime-free and
 * unit-testable. The numeric values are part of Monaco's stable public API.
 */
const SYMBOL_KIND_LABELS: Record<number, string> = {
  0: "File",
  1: "Module",
  2: "Namespace",
  3: "Package",
  4: "Class",
  5: "Method",
  6: "Property",
  7: "Field",
  8: "Constructor",
  9: "Enum",
  10: "Interface",
  11: "Function",
  12: "Variable",
  13: "Constant",
  14: "String",
  15: "Number",
  16: "Boolean",
  17: "Array",
  18: "Object",
  19: "Key",
  20: "Null",
  21: "EnumMember",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "TypeParameter",
};

/** Human label for a Monaco-numeric SymbolKind; falls back to "Symbol". */
export function symbolKindLabel(kind: number): string {
  return SYMBOL_KIND_LABELS[kind] ?? "Symbol";
}

/**
 * Normalize Monaco's hierarchical symbols into OutlineNodes with stable ids
 * and depth. Ids are path-scoped (`parentId/idx:name@line`) so two symbols
 * with the same name at different scopes never collide, and an id is stable
 * across re-sorts because it encodes the *source* position, not the sorted
 * index.
 */
export function buildOutline(
  symbols: readonly DocumentSymbolLike[] | null | undefined,
): OutlineNode[] {
  if (!symbols || symbols.length === 0) return [];

  const walk = (
    list: readonly DocumentSymbolLike[],
    depth: number,
    parentId: string,
  ): OutlineNode[] =>
    list.map((s, idx) => {
      const id = `${parentId}${idx}:${s.name}@${s.range.startLineNumber}/`;
      return {
        id,
        name: s.name,
        detail: s.detail ?? "",
        kind: s.kind,
        depth,
        range: s.range,
        selectionRange: s.selectionRange ?? s.range,
        children: walk(s.children ?? [], depth + 1, id),
      };
    });

  return walk(symbols, 0, "");
}

/**
 * Case-insensitive substring filter. A node is kept when its own name
 * matches OR any descendant matches; ancestors of a match are retained so
 * the tree shape is preserved (VS Code behaviour). An empty / whitespace
 * query returns the tree unchanged (same references).
 */
export function filterOutline(
  nodes: readonly OutlineNode[],
  query: string,
): OutlineNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes as OutlineNode[];

  const filterList = (list: readonly OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const node of list) {
      const selfMatch = node.name.toLowerCase().includes(q);
      const keptChildren = filterList(node.children);
      if (selfMatch || keptChildren.length > 0) {
        out.push({ ...node, children: keptChildren });
      }
    }
    return out;
  };

  return filterList(nodes);
}

function compareName(a: OutlineNode, b: OutlineNode): number {
  return a.name.localeCompare(b.name);
}

function comparePosition(a: OutlineNode, b: OutlineNode): number {
  if (a.range.startLineNumber !== b.range.startLineNumber) {
    return a.range.startLineNumber - b.range.startLineNumber;
  }
  return a.range.startColumn - b.range.startColumn;
}

/**
 * Recursively sort the tree. `position` orders by source location,
 * `name` alphabetically, `kind` groups by SymbolKind then name. All modes
 * are stable for equal keys (Array.prototype.sort is stable on modern
 * engines, and we never mutate the input — each level is copied first).
 */
export function sortOutline(
  nodes: readonly OutlineNode[],
  mode: OutlineSortMode,
): OutlineNode[] {
  const cmp =
    mode === "name"
      ? compareName
      : mode === "kind"
        ? (a: OutlineNode, b: OutlineNode) =>
            a.kind !== b.kind ? a.kind - b.kind : compareName(a, b)
        : comparePosition;

  const sortList = (list: readonly OutlineNode[]): OutlineNode[] =>
    [...list]
      .sort(cmp)
      .map((n) =>
        n.children.length ? { ...n, children: sortList(n.children) } : n,
      );

  return sortList(nodes);
}

/**
 * Flatten the tree into the rows the UI renders, honouring collapse state.
 * A node whose id is in `collapsed` contributes its own row but none of its
 * descendants. Pre-order (depth-first) — matches the visual tree order.
 */
export function flattenVisible(
  nodes: readonly OutlineNode[],
  collapsed: ReadonlySet<string>,
): FlatOutlineRow[] {
  const rows: FlatOutlineRow[] = [];

  const visit = (list: readonly OutlineNode[]) => {
    for (const node of list) {
      const hasChildren = node.children.length > 0;
      const isCollapsed = hasChildren && collapsed.has(node.id);
      rows.push({ node, hasChildren, collapsed: isCollapsed });
      if (hasChildren && !isCollapsed) visit(node.children);
    }
  };

  visit(nodes);
  return rows;
}

/**
 * Find the id of the deepest symbol whose range contains `line` (1-indexed,
 * end-inclusive). Used for cursor-follow highlighting. Returns null when no
 * symbol contains the line. When siblings overlap (shouldn't happen for
 * well-formed symbols, but defensive), the first containing sibling at each
 * level wins and we descend into it.
 */
export function findActiveSymbolId(
  nodes: readonly OutlineNode[],
  line: number,
): string | null {
  let activeId: string | null = null;

  const visit = (list: readonly OutlineNode[]) => {
    for (const node of list) {
      if (
        line >= node.range.startLineNumber &&
        line <= node.range.endLineNumber
      ) {
        activeId = node.id;
        visit(node.children); // a deeper child overwrites the parent
        return; // first containing sibling wins
      }
    }
  };

  visit(nodes);
  return activeId;
}

/**
 * Convenience: the chain of node ids from root to the active symbol. The
 * Outline UI uses this to auto-expand collapsed ancestors so the active
 * row is visible. Empty when nothing contains the line.
 */
export function activeSymbolPath(
  nodes: readonly OutlineNode[],
  line: number,
): string[] {
  const path: string[] = [];

  const visit = (list: readonly OutlineNode[]): boolean => {
    for (const node of list) {
      if (
        line >= node.range.startLineNumber &&
        line <= node.range.endLineNumber
      ) {
        path.push(node.id);
        visit(node.children);
        return true;
      }
    }
    return false;
  };

  visit(nodes);
  return path;
}
