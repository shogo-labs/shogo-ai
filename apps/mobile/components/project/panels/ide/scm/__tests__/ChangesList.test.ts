/**
 * ChangesList — comprehensive unit tests for buildGroups, buildTree, and
 * formatChangeCount. Covers:
 *
 * - Staged vs unstaged routing (BUG-001 fix: stagedStatus map)
 * - fileChanges passthrough (numstat counts in file rows)
 * - BUG-007 exclusions (!, ·)
 * - Conflict routing to Merge group
 * - Group visibility rules
 * - Tree building from flat file list
 * - formatChangeCount edge cases
 */
import { describe, expect, test } from "bun:test";
import type { GitSnapshot, GitShortCode } from "../../git/bridge";
import { isCountedGitCode } from "../../git/git-counting";

interface Group {
  id: "merge" | "staged" | "changes";
  label: string;
  files: { path: string; code: GitShortCode | "·"; added?: number; removed?: number }[];
  emptyHint?: string;
}

function buildGroups(snapshot: GitSnapshot): Group[] {
  const merge: Group["files"] = [];
  const staged: Group["files"] = [];
  const working: Group["files"] = [];
  for (const path of snapshot.conflictPaths) {
    merge.push({ path, code: snapshot.fileStatus[path] ?? "U" });
  }
  const stagedPaths = new Set(Object.keys(snapshot.stagedStatus));
  for (const [path, code] of Object.entries(snapshot.fileStatus)) {
    if (snapshot.conflictPaths.includes(path)) continue;
    if (!isCountedGitCode(code)) continue;
    if (stagedPaths.has(path)) {
      const changes = snapshot.fileChanges?.[path];
      staged.push({ path, code, added: changes?.added, removed: changes?.removed });
    } else {
      const changes = snapshot.fileChanges?.[path];
      working.push({ path, code, added: changes?.added, removed: changes?.removed });
    }
  }
  const groups: Group[] = [
    { id: "merge", label: "Merge Changes", files: merge, emptyHint: undefined },
    { id: "staged", label: "Staged Changes", files: staged, emptyHint: "Nothing staged" },
    { id: "changes", label: "Changes", files: working, emptyHint: "Working tree clean" },
  ];
  return groups.filter((g) => g.files.length > 0);
}

interface DirNode {
  name: string;
  path: string;
  children: DirNode[];
  files: { path: string; code: GitShortCode | "·"; added?: number; removed?: number }[];
}

function buildTree(files: Group["files"]): DirNode[] {
  const root: DirNode = { name: "", path: "", children: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let child = node.children.find((c) => c.name === dirName);
      if (!child) {
        child = { name: dirName, path: parts.slice(0, i + 1).join("/"), children: [], files: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root.children;
}

function formatChangeCount(added?: number, removed?: number): string {
  if (added === undefined && removed === undefined) return "";
  const a = added ?? 0;
  const r = removed ?? 0;
  const parts: string[] = [];
  if (a > 0) parts.push(`+${a > 99 ? "99+" : a}`);
  if (r > 0) parts.push(`-${r > 99 ? "99+" : r}`);
  return parts.join(" ");
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

// ═══════════ buildGroups ═══════════

describe("buildGroups — staged vs unstaged routing", () => {
  test("files in stagedStatus go to Staged group", () => {
    const s = snap({ "a.ts": "M", "b.ts": "A" }, { stagedStatus: { "a.ts": "M" } });
    const staged = buildGroups(s).find((g) => g.id === "staged")!;
    const changes = buildGroups(s).find((g) => g.id === "changes")!;
    expect(staged.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(changes.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  test("empty stagedStatus sends everything to Changes", () => {
    const s = snap({ "a.ts": "M", "b.ts": "D" });
    expect(buildGroups(s).find((g) => g.id === "staged")).toBeUndefined();
    expect(buildGroups(s).find((g) => g.id === "changes")!.files.length).toBe(2);
  });

  test("all files staged hides empty Changes group", () => {
    const s = snap({ "a.ts": "M" }, { stagedStatus: { "a.ts": "M" } });
    expect(buildGroups(s).find((g) => g.id === "staged")!.files.length).toBe(1);
    expect(buildGroups(s).find((g) => g.id === "changes")).toBeUndefined();
  });

  test("mixed staged and unstaged", () => {
    const s = snap(
      { "a.ts": "M", "b.ts": "A", "c.ts": "D", "d.ts": "R" },
      { stagedStatus: { "a.ts": "M", "c.ts": "D" } },
    );
    expect(buildGroups(s).find((g) => g.id === "staged")!.files.map((f) => f.path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(buildGroups(s).find((g) => g.id === "changes")!.files.map((f) => f.path).sort()).toEqual(["b.ts", "d.ts"]);
  });
});

describe("buildGroups — fileChanges passthrough", () => {
  test("fileChanges passthrough to staged files", () => {
    const s = snap({ "a.ts": "M" }, {
      stagedStatus: { "a.ts": "M" },
      fileChanges: { "a.ts": { added: 12, removed: 3 } },
    });
    const f = buildGroups(s).find((g) => g.id === "staged")!.files[0];
    expect(f.added).toBe(12);
    expect(f.removed).toBe(3);
  });

  test("fileChanges passthrough to unstaged files", () => {
    const s = snap({ "b.ts": "A" }, { fileChanges: { "b.ts": { added: 45, removed: 0 } } });
    const f = buildGroups(s).find((g) => g.id === "changes")!.files[0];
    expect(f.added).toBe(45);
    expect(f.removed).toBe(0);
  });

  test("fileChanges missing → added/removed stay undefined", () => {
    const s = snap({ "c.ts": "M" });
    const f = buildGroups(s).find((g) => g.id === "changes")!.files[0];
    expect(f.added).toBeUndefined();
    expect(f.removed).toBeUndefined();
  });
});

describe("buildGroups — BUG-007 exclusions", () => {
  test("'!' excluded", () => {
    const s = snap({ "a.ts": "M", "node_modules/x.js": "!" });
    expect(buildGroups(s).find((g) => g.id === "changes")!.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  test("'·' excluded", () => {
    const s = snap({ "real.ts": "M", "phantom": "·" as unknown as GitShortCode });
    expect(buildGroups(s).find((g) => g.id === "changes")!.files.map((f) => f.path)).toEqual(["real.ts"]);
  });

  test("ONLY ignored hides Changes", () => {
    const s = snap({ "a": "!", "b": "!" });
    expect(buildGroups(s).find((g) => g.id === "changes")).toBeUndefined();
  });
});

describe("buildGroups — conflicts", () => {
  test("conflict paths go to Merge", () => {
    const s = snap({ "c.ts": "U" }, { conflictPaths: ["c.ts"] });
    expect(buildGroups(s).find((g) => g.id === "merge")!.files.map((f) => f.path)).toEqual(["c.ts"]);
    expect(buildGroups(s).find((g) => g.id === "changes")).toBeUndefined();
  });

  test("missing from fileStatus defaults to 'U'", () => {
    const s = snap({}, { conflictPaths: ["lost.ts"] });
    expect(buildGroups(s).find((g) => g.id === "merge")!.files[0]).toEqual({
      path: "lost.ts", code: "U", added: undefined, removed: undefined,
    });
  });
});

describe("buildGroups — visibility", () => {
  test("merge hidden without conflicts", () => {
    expect(buildGroups(snap({ "a": "M" })).find((g) => g.id === "merge")).toBeUndefined();
  });

  test("staged + changes hidden when empty", () => {
    const groups = buildGroups(snap({}));
    expect(groups.find((g) => g.id === "changes")).toBeUndefined();
    expect(groups.find((g) => g.id === "staged")).toBeUndefined();
  });
});

// ═══════════ buildTree ═══════════

describe("buildTree — directory grouping", () => {
  test("flat files → no tree nodes", () => {
    expect(buildTree([{ path: "a.ts", code: "M" }])).toEqual([]);
  });

  test("nested files → correct structure", () => {
    const tree = buildTree([
      { path: "src/components/Button.tsx", code: "M" },
      { path: "src/components/Card.tsx", code: "A" },
      { path: "src/utils/format.ts", code: "M" },
      { path: "lib/index.ts", code: "D" },
    ]);
    expect(tree.length).toBe(2);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.children.length).toBe(2);
    expect(src.files.length).toBe(0);
    const comp = src.children.find((n) => n.name === "components")!;
    expect(comp.files.length).toBe(2);
    const lib = tree.find((n) => n.name === "lib")!;
    expect(lib.files.length).toBe(1);
  });

  test("3+ levels deep", () => {
    const tree = buildTree([{ path: "a/b/c/d.ts", code: "M" }]);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children[0].name).toBe("b");
    expect(tree[0].children[0].children[0].name).toBe("c");
    expect(tree[0].children[0].children[0].files[0].path).toBe("a/b/c/d.ts");
  });

  test("empty list → empty tree", () => {
    expect(buildTree([])).toEqual([]);
  });

  test("fileChanges preserved through tree", () => {
    const tree = buildTree([{ path: "src/a.ts", code: "M", added: 10, removed: 5 }]);
    expect(tree[0].files[0].added).toBe(10);
    expect(tree[0].files[0].removed).toBe(5);
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
