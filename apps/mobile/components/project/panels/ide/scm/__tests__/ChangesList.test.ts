/**
 * ChangesList data layer — section routing, tree building, and the change-count
 * badge. These previously RE-IMPLEMENTED the production logic inline (and so
 * tested copies, not the shipping code). They now import the real exported
 * functions from scm/grouping.ts — the same ones ChangesList renders from.
 *
 * Covers:
 * - Staged vs unstaged routing (BUG-001: stagedStatus map)
 * - fileChanges passthrough (numstat counts in file rows)
 * - BUG-007 exclusions (!, ·)
 * - Conflict routing to Merge
 * - Tree building (real compaction + sort)
 * - formatChangeCount edge cases
 */
import { describe, expect, test } from "bun:test";
import type { GitSnapshot, GitShortCode } from "../../git/bridge";
import {
  buildChangesTree,
  formatChangeCount,
  getFilesForSection,
  type ChangesSection,
} from "../grouping";

/** Derive the visible, non-empty groups from the real per-section function. */
function buildGroups(snapshot: GitSnapshot): { id: ChangesSection; files: { path: string; added?: number; removed?: number }[] }[] {
  return (["merge", "staged", "changes"] as ChangesSection[])
    .map((id) => ({ id, files: getFilesForSection(snapshot, id) }))
    .filter((g) => g.files.length > 0);
}

function snap(
  fileStatus: Record<string, GitShortCode>,
  opts?: {
    stagedStatus?: Record<string, GitShortCode>;
    fileChanges?: Record<string, { added: number; removed: number }>;
    conflictPaths?: string[];
  },
): GitSnapshot {
  return {
    isRepo: true,
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    fileStatus,
    stagedStatus: opts?.stagedStatus ?? {},
    fileChanges: opts?.fileChanges ?? {},
    conflictPaths: opts?.conflictPaths ?? [],
    error: null,
    workspaceRoot: "/",
    refreshedAt: Date.now(),
  };
}

// ═══════════ getFilesForSection (staged vs unstaged routing) ═══════════

describe("getFilesForSection — staged vs unstaged routing", () => {
  test("files in stagedStatus go to Staged", () => {
    const s = snap({ "a.ts": "M", "b.ts": "A" }, { stagedStatus: { "a.ts": "M" } });
    expect(getFilesForSection(s, "staged").map((f) => f.path)).toEqual(["a.ts"]);
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["b.ts"]);
  });

  test("empty stagedStatus sends everything to Changes", () => {
    const s = snap({ "a.ts": "M", "b.ts": "D" });
    expect(getFilesForSection(s, "staged")).toEqual([]);
    expect(getFilesForSection(s, "changes").length).toBe(2);
  });

  test("all files staged leaves Changes empty", () => {
    const s = snap({ "a.ts": "M" }, { stagedStatus: { "a.ts": "M" } });
    expect(getFilesForSection(s, "staged").length).toBe(1);
    expect(getFilesForSection(s, "changes")).toEqual([]);
  });

  test("mixed staged and unstaged", () => {
    const s = snap(
      { "a.ts": "M", "b.ts": "A", "c.ts": "D", "d.ts": "R" },
      { stagedStatus: { "a.ts": "M", "c.ts": "D" } },
    );
    expect(getFilesForSection(s, "staged").map((f) => f.path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(getFilesForSection(s, "changes").map((f) => f.path).sort()).toEqual(["b.ts", "d.ts"]);
  });
});

describe("getFilesForSection — fileChanges passthrough", () => {
  test("passthrough to staged files", () => {
    const s = snap({ "a.ts": "M" }, {
      stagedStatus: { "a.ts": "M" },
      fileChanges: { "a.ts": { added: 12, removed: 3 } },
    });
    const f = getFilesForSection(s, "staged")[0];
    expect(f.added).toBe(12);
    expect(f.removed).toBe(3);
  });

  test("passthrough to unstaged files", () => {
    const s = snap({ "b.ts": "A" }, { fileChanges: { "b.ts": { added: 45, removed: 0 } } });
    const f = getFilesForSection(s, "changes")[0];
    expect(f.added).toBe(45);
    expect(f.removed).toBe(0);
  });

  test("missing fileChanges → added/removed stay undefined", () => {
    const s = snap({ "c.ts": "M" });
    const f = getFilesForSection(s, "changes")[0];
    expect(f.added).toBeUndefined();
    expect(f.removed).toBeUndefined();
  });
});

describe("getFilesForSection — BUG-007 exclusions", () => {
  test("'!' excluded", () => {
    const s = snap({ "a.ts": "M", "node_modules/x.js": "!" });
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["a.ts"]);
  });

  test("'·' excluded", () => {
    const s = snap({ "real.ts": "M", "phantom": "·" as unknown as GitShortCode });
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["real.ts"]);
  });

  test("ONLY ignored leaves Changes empty", () => {
    const s = snap({ "a": "!", "b": "!" });
    expect(getFilesForSection(s, "changes")).toEqual([]);
  });
});

describe("getFilesForSection — conflicts", () => {
  test("conflict paths go to Merge", () => {
    const s = snap({ "c.ts": "U" }, { conflictPaths: ["c.ts"] });
    expect(getFilesForSection(s, "merge").map((f) => f.path)).toEqual(["c.ts"]);
    expect(getFilesForSection(s, "changes")).toEqual([]);
  });

  test("missing from fileStatus defaults to 'U'", () => {
    const s = snap({}, { conflictPaths: ["lost.ts"] });
    expect(getFilesForSection(s, "merge")[0]).toEqual({ path: "lost.ts", code: "U" });
  });
});

describe("buildGroups (derived) — visibility", () => {
  test("merge hidden without conflicts", () => {
    expect(buildGroups(snap({ "a": "M" })).find((g) => g.id === "merge")).toBeUndefined();
  });

  test("staged + changes hidden when empty", () => {
    expect(buildGroups(snap({}))).toEqual([]);
  });
});

// ═══════════ buildChangesTree (real compaction + sort) ═══════════

describe("buildChangesTree — directory grouping", () => {
  test("flat files stay at root (no dir nodes)", () => {
    const tree = buildChangesTree([{ path: "a.ts", code: "M" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("file");
  });

  test("nested files build directory nodes", () => {
    const tree = buildChangesTree([
      { path: "src/components/Button.tsx", code: "M" },
      { path: "src/components/Card.tsx", code: "A" },
      { path: "src/utils/format.ts", code: "M" },
      { path: "lib/index.ts", code: "D" },
    ]);
    // Top level: lib (dir), src (dir) — sorted alphabetically, dirs first.
    expect(tree.map((n) => n.name)).toEqual(["lib", "src"]);
  });

  test("fileChanges preserved through the tree", () => {
    const tree = buildChangesTree([{ path: "src/a.ts", code: "M", added: 10, removed: 5 }]);
    const dir = tree[0];
    if (dir.type !== "dir") throw new Error("expected dir");
    const leaf = dir.children[0];
    if (leaf.type !== "file") throw new Error("expected file");
    expect(leaf.file.added).toBe(10);
    expect(leaf.file.removed).toBe(5);
  });

  test("empty list → empty tree", () => {
    expect(buildChangesTree([])).toEqual([]);
  });
});

// ═══════════ formatChangeCount ═══════════

describe("formatChangeCount", () => {
  test("both undefined → empty", () => expect(formatChangeCount(undefined, undefined)).toBe(""));
  test("only added", () => expect(formatChangeCount(12, 0)).toBe("+12"));
  test("only removed", () => expect(formatChangeCount(0, 5)).toBe("-5"));
  test("both positive", () => expect(formatChangeCount(10, 3)).toBe("+10 -3"));
  test("large → 99+", () => expect(formatChangeCount(150, 200)).toBe("+99+ -99+"));
  test("zero/zero → empty", () => expect(formatChangeCount(0, 0)).toBe(""));
  test("undefined mixed", () => {
    expect(formatChangeCount(undefined, 5)).toBe("-5");
    expect(formatChangeCount(3, undefined)).toBe("+3");
  });
});
