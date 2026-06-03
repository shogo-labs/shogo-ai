// SPDX-License-Identifier: MIT
import { test, expect } from "bun:test";
import {
  buildOutline,
  filterOutline,
  sortOutline,
  flattenVisible,
  findActiveSymbolId,
  activeSymbolPath,
  symbolKindLabel,
  OUTLINE_SORT_MODES,
  OUTLINE_SORT_LABELS,
  type DocumentSymbolLike,
} from "../outline-model";

// ── helpers ────────────────────────────────────────────────────────────
function rng(startLine: number, endLine: number, startCol = 1) {
  return {
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: 1,
  };
}

function sym(
  name: string,
  kind: number,
  startLine: number,
  endLine: number,
  children: DocumentSymbolLike[] = [],
  startCol = 1,
): DocumentSymbolLike {
  return {
    name,
    kind,
    range: rng(startLine, endLine, startCol),
    selectionRange: rng(startLine, startLine, startCol),
    children,
  };
}

// A small representative tree:
//   ClassA            (kind 4)  lines 1-20
//     methodB         (kind 5)  lines 2-5
//     methodA         (kind 5)  lines 7-19
//       localFn       (kind 11) lines 8-10
//   funcZ             (kind 11) lines 22-25
function sampleSymbols(): DocumentSymbolLike[] {
  return [
    sym("ClassA", 4, 1, 20, [
      sym("methodB", 5, 2, 5),
      sym("methodA", 5, 7, 19, [sym("localFn", 11, 8, 10)]),
    ]),
    sym("funcZ", 11, 22, 25),
  ];
}

// ── buildOutline ───────────────────────────────────────────────────────
test("buildOutline empty / null / undefined", () => {
  expect(buildOutline([])).toEqual([]);
  expect(buildOutline(null)).toEqual([]);
  expect(buildOutline(undefined)).toEqual([]);
});

test("buildOutline assigns depth and stable scoped ids", () => {
  const tree = buildOutline(sampleSymbols());
  expect(tree.length).toBe(2);
  expect(tree[0].name).toBe("ClassA");
  expect(tree[0].depth).toBe(0);
  expect(tree[0].children[0].name).toBe("methodB");
  expect(tree[0].children[0].depth).toBe(1);
  expect(tree[0].children[1].children[0].name).toBe("localFn");
  expect(tree[0].children[1].children[0].depth).toBe(2);

  // ids are unique across the whole tree
  const ids: string[] = [];
  const collect = (ns: typeof tree) =>
    ns.forEach((n) => {
      ids.push(n.id);
      collect(n.children);
    });
  collect(tree);
  expect(new Set(ids).size).toBe(ids.length);
});

test("buildOutline same-name symbols in different scopes get distinct ids", () => {
  const tree = buildOutline([
    sym("render", 5, 1, 3),
    sym("Comp", 4, 5, 10, [sym("render", 5, 6, 8)]),
  ]);
  expect(tree[0].id).not.toBe(tree[1].children[0].id);
});

test("buildOutline falls back selectionRange to range when missing", () => {
  const s: DocumentSymbolLike = {
    name: "x",
    kind: 12,
    range: rng(3, 4),
    selectionRange: undefined as unknown as DocumentSymbolLike["selectionRange"],
  };
  const tree = buildOutline([s]);
  expect(tree[0].selectionRange).toEqual(rng(3, 4));
});

// ── filterOutline ──────────────────────────────────────────────────────
test("filterOutline empty query returns input unchanged (same ref)", () => {
  const tree = buildOutline(sampleSymbols());
  expect(filterOutline(tree, "")).toBe(tree);
  expect(filterOutline(tree, "   ")).toBe(tree);
});

test("filterOutline is case-insensitive substring", () => {
  const tree = buildOutline(sampleSymbols());
  const r = filterOutline(tree, "classa");
  expect(r.length).toBe(1);
  expect(r[0].name).toBe("ClassA");
});

test("filterOutline keeps ancestors of a deep match", () => {
  const tree = buildOutline(sampleSymbols());
  const r = filterOutline(tree, "localFn");
  // funcZ dropped; ClassA kept as ancestor; only the matching branch remains
  expect(r.length).toBe(1);
  expect(r[0].name).toBe("ClassA");
  expect(r[0].children.length).toBe(1);
  expect(r[0].children[0].name).toBe("methodA");
  expect(r[0].children[0].children[0].name).toBe("localFn");
});

test("filterOutline self-match keeps node even if children drop", () => {
  const tree = buildOutline(sampleSymbols());
  const r = filterOutline(tree, "ClassA");
  // ClassA matches; none of its children match "ClassA" → children pruned
  expect(r[0].name).toBe("ClassA");
  expect(r[0].children.length).toBe(0);
});

test("filterOutline no match returns empty", () => {
  const tree = buildOutline(sampleSymbols());
  expect(filterOutline(tree, "zzzznotpresent")).toEqual([]);
});

test("filterOutline matches multiple siblings", () => {
  const tree = buildOutline(sampleSymbols());
  const r = filterOutline(tree, "method");
  expect(r.length).toBe(1);
  expect(r[0].children.map((c) => c.name).sort()).toEqual([
    "methodA",
    "methodB",
  ]);
});

// ── sortOutline ────────────────────────────────────────────────────────
test("sortOutline by position orders by start line then column", () => {
  const tree = buildOutline([
    sym("b", 12, 10, 11),
    sym("a", 12, 5, 6),
    sym("c", 12, 5, 6, [], 8), // same line as 'a', later column
  ]);
  const r = sortOutline(tree, "position");
  expect(r.map((n) => n.name)).toEqual(["a", "c", "b"]);
});

test("sortOutline by name is alphabetical and recursive", () => {
  const tree = buildOutline(sampleSymbols());
  const r = sortOutline(tree, "name");
  expect(r.map((n) => n.name)).toEqual(["ClassA", "funcZ"]);
  // children of ClassA: methodA before methodB
  expect(r[0].children.map((n) => n.name)).toEqual(["methodA", "methodB"]);
});

test("sortOutline by kind groups by kind then name", () => {
  const tree = buildOutline([
    sym("zFunc", 11, 1, 2),
    sym("aClass", 4, 3, 4),
    sym("bClass", 4, 5, 6),
  ]);
  const r = sortOutline(tree, "kind");
  // kind 4 (Class) before kind 11 (Function); within kind, by name
  expect(r.map((n) => n.name)).toEqual(["aClass", "bClass", "zFunc"]);
});

test("sortOutline does not mutate input", () => {
  const tree = buildOutline([sym("b", 12, 2, 2), sym("a", 12, 1, 1)]);
  const before = tree.map((n) => n.name);
  sortOutline(tree, "name");
  expect(tree.map((n) => n.name)).toEqual(before);
});

// ── flattenVisible ─────────────────────────────────────────────────────
test("flattenVisible fully expanded yields every node pre-order", () => {
  const tree = buildOutline(sampleSymbols());
  const rows = flattenVisible(tree, new Set());
  expect(rows.map((r) => r.node.name)).toEqual([
    "ClassA",
    "methodB",
    "methodA",
    "localFn",
    "funcZ",
  ]);
  expect(rows[0].hasChildren).toBe(true);
  expect(rows[1].hasChildren).toBe(false);
});

test("flattenVisible hides descendants of collapsed nodes", () => {
  const tree = buildOutline(sampleSymbols());
  const classA = tree[0].id;
  const rows = flattenVisible(tree, new Set([classA]));
  expect(rows.map((r) => r.node.name)).toEqual(["ClassA", "funcZ"]);
  expect(rows[0].collapsed).toBe(true);
});

test("flattenVisible collapsing a leaf id is a no-op", () => {
  const tree = buildOutline(sampleSymbols());
  const leaf = tree[1].id; // funcZ has no children
  const rows = flattenVisible(tree, new Set([leaf]));
  expect(rows.length).toBe(5);
  // a leaf can never be reported collapsed
  expect(rows.find((r) => r.node.id === leaf)!.collapsed).toBe(false);
});

test("flattenVisible nested collapse only hides that subtree", () => {
  const tree = buildOutline(sampleSymbols());
  const methodA = tree[0].children[1].id;
  const rows = flattenVisible(tree, new Set([methodA]));
  expect(rows.map((r) => r.node.name)).toEqual([
    "ClassA",
    "methodB",
    "methodA", // shown but collapsed
    "funcZ",
  ]);
});

// ── findActiveSymbolId / activeSymbolPath ──────────────────────────────
test("findActiveSymbolId returns deepest containing symbol", () => {
  const tree = buildOutline(sampleSymbols());
  // line 9 is inside localFn (8-10) ⊂ methodA (7-19) ⊂ ClassA (1-20)
  const id = findActiveSymbolId(tree, 9);
  expect(id).toBe(tree[0].children[1].children[0].id); // localFn
});

test("findActiveSymbolId mid-method (not in nested fn) returns the method", () => {
  const tree = buildOutline(sampleSymbols());
  const id = findActiveSymbolId(tree, 15); // in methodA (7-19) but not localFn
  expect(id).toBe(tree[0].children[1].id);
});

test("findActiveSymbolId on boundary lines is inclusive", () => {
  const tree = buildOutline(sampleSymbols());
  expect(findActiveSymbolId(tree, 1)).toBe(tree[0].id); // ClassA start
  expect(findActiveSymbolId(tree, 20)).toBe(tree[0].id); // ClassA end
  expect(findActiveSymbolId(tree, 22)).toBe(tree[1].id); // funcZ start
});

test("findActiveSymbolId returns null when no symbol contains the line", () => {
  const tree = buildOutline(sampleSymbols());
  expect(findActiveSymbolId(tree, 21)).toBeNull(); // gap between ClassA and funcZ
  expect(findActiveSymbolId(tree, 999)).toBeNull();
  expect(findActiveSymbolId([], 1)).toBeNull();
});

test("activeSymbolPath returns root→leaf id chain", () => {
  const tree = buildOutline(sampleSymbols());
  const path = activeSymbolPath(tree, 9);
  expect(path).toEqual([
    tree[0].id, // ClassA
    tree[0].children[1].id, // methodA
    tree[0].children[1].children[0].id, // localFn
  ]);
});

test("activeSymbolPath empty when line outside all symbols", () => {
  const tree = buildOutline(sampleSymbols());
  expect(activeSymbolPath(tree, 21)).toEqual([]);
});

// ── symbolKindLabel + constants ────────────────────────────────────────
test("symbolKindLabel maps known kinds and falls back", () => {
  expect(symbolKindLabel(4)).toBe("Class");
  expect(symbolKindLabel(5)).toBe("Method");
  expect(symbolKindLabel(11)).toBe("Function");
  expect(symbolKindLabel(12)).toBe("Variable");
  expect(symbolKindLabel(999)).toBe("Symbol");
  expect(symbolKindLabel(-1)).toBe("Symbol");
});

test("sort modes + labels are consistent", () => {
  expect(OUTLINE_SORT_MODES).toEqual(["position", "name", "kind"]);
  OUTLINE_SORT_MODES.forEach((m) => {
    expect(typeof OUTLINE_SORT_LABELS[m]).toBe("string");
    expect(OUTLINE_SORT_LABELS[m].length).toBeGreaterThan(0);
  });
});
