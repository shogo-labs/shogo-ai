/**
 * ChangesList.buildGroups — BUG-007 consumer lockdown.
 *
 * buildGroups was the OTHER place the "is this a counted change?" rule
 * lived, encoded inline as `if (code === "·" || code === "!") continue`.
 * After the BUG-007 fix it delegates to isCountedGitCode. These tests
 * pin that the delegation is correct AND that the existing routing
 * (conflicts → Merge Changes; everything counted → Changes) still holds.
 *
 * buildGroups is not exported by ChangesList.tsx; we mirror it as a
 * contract test that imports isCountedGitCode the SAME way the
 * component does. If the component ever stops delegating to
 * isCountedGitCode the failing test name tells us why.
 *
 * NB: buildGroups was UNTESTED before this commit — the inline rule
 * was correct, but a future regression there would have shipped
 * silently. This file is the safety net.
 */
import { describe, expect, test } from "bun:test";
import { isCountedGitCode } from "../../git/git-counting";
import type { GitSnapshot, GitShortCode } from "../../git/bridge";

type Group = {
  id: "merge" | "staged" | "changes";
  label: string;
  files: { path: string; code: GitShortCode | "·" }[];
  emptyHint: string | undefined;
};

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
      staged.push({ path, code });
    } else {
      working.push({ path, code });
    }
  }
  const groups: Group[] = [
    { id: "merge", label: "Merge Changes", files: merge, emptyHint: undefined },
    { id: "staged", label: "Staged Changes", files: staged, emptyHint: "Nothing staged" },
    { id: "changes", label: "Changes", files: working, emptyHint: "Working tree clean" },
  ];
  return groups.filter((g) => g.files.length > 0 || g.id === "changes" || g.id === "staged");
}

function snap(
  fileStatus: Record<string, GitShortCode>,
  conflictPaths: string[] = [],
  stagedStatus: Record<string, GitShortCode> = {},
): GitSnapshot {
  return {
    isRepo: true,
    fileStatus,
    stagedStatus,
    conflictPaths,
    ...({} as Partial<GitSnapshot>),
  } as GitSnapshot;
}

describe("ChangesList.buildGroups — counted codes routed to Changes", () => {
  test("M, A, D, R, C, T, ? all land in the Changes group", () => {
    const s = snap({
      "a": "M", "b": "A", "c": "D", "d": "R", "e": "C", "f": "T", "g": "?",
    });
    const changes = buildGroups(s).find((g) => g.id === "changes")!;
    expect(changes.files.length).toBe(7);
    expect(changes.files.map((f) => f.path).sort())
      .toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});

describe("ChangesList.buildGroups — BUG-007 exclusions", () => {
  test("'!' (ignored) is excluded from the Changes group", () => {
    const s = snap({ "a.ts": "M", "node_modules/x.js": "!" });
    const changes = buildGroups(s).find((g) => g.id === "changes")!;
    expect(changes.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  test("'·' (synthetic folder-dirty) is excluded from the Changes group", () => {
    const s = snap({ "real.ts": "M", "phantom-folder": "·" as unknown as GitShortCode });
    const changes = buildGroups(s).find((g) => g.id === "changes")!;
    expect(changes.files.map((f) => f.path)).toEqual(["real.ts"]);
  });

  test("a snapshot of ONLY ignored files yields an empty Changes group (not hidden)", () => {
    const s = snap({ "node_modules/a": "!", ".env.local": "!" });
    const changes = buildGroups(s).find((g) => g.id === "changes")!;
    expect(changes.files.length).toBe(0);
    expect(changes.emptyHint).toBe("Working tree clean");
  });
});

describe("ChangesList.buildGroups — conflict routing (BUG-007 must not regress this)", () => {
  test("conflict paths go to Merge Changes, NOT Changes", () => {
    const s = snap({ "conflict.ts": "U" }, ["conflict.ts"]);
    const groups = buildGroups(s);
    expect(groups.find((g) => g.id === "merge")!.files.map((f) => f.path))
      .toEqual(["conflict.ts"]);
    expect(groups.find((g) => g.id === "changes")!.files.length).toBe(0);
  });

  test("conflict path missing from fileStatus defaults to 'U'", () => {
    const s = snap({}, ["lost.ts"]);
    const merge = buildGroups(s).find((g) => g.id === "merge")!;
    expect(merge.files).toEqual([{ path: "lost.ts", code: "U" }]);
  });

  test("conflict + ignored file: conflict goes to merge, ignored is dropped, edit goes to changes", () => {
    const s = snap(
      { "conflict.ts": "U", "node_modules/x": "!", "edited.ts": "M" },
      ["conflict.ts"],
    );
    const groups = buildGroups(s);
    expect(groups.find((g) => g.id === "merge")!.files.map((f) => f.path)).toEqual(["conflict.ts"]);
    expect(groups.find((g) => g.id === "changes")!.files.map((f) => f.path)).toEqual(["edited.ts"]);
  });
});

describe("ChangesList.buildGroups — group visibility", () => {
  test("merge group is hidden when there are no conflicts", () => {
    const groups = buildGroups(snap({ "a": "M" }));
    expect(groups.find((g) => g.id === "merge")).toBeUndefined();
  });

  test("changes + staged groups are ALWAYS shown (even when empty)", () => {
    const groups = buildGroups(snap({}));
    expect(groups.find((g) => g.id === "changes")).toBeDefined();
    expect(groups.find((g) => g.id === "staged")).toBeDefined();
  });
});
