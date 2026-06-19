/**
 * Section routing — BUG-007 consumer lockdown.
 *
 * Previously this file RE-IMPLEMENTED the production `buildGroups` logic inline
 * and tested the copy, so a regression in the real code would have shipped
 * silently. The routing rule now lives in the exported `getFilesForSection`
 * (scm/grouping.ts), and these tests drive THAT function directly — the same
 * one ChangesList renders from. If the production routing breaks, this breaks.
 */
import { describe, expect, test } from "bun:test";
import { getFilesForSection, type ChangesSection } from "../grouping";
import type { GitSnapshot, GitShortCode } from "../../git/bridge";

/** Recreate the three on-screen groups from the production section function. */
function buildGroups(snapshot: GitSnapshot): { id: ChangesSection; paths: string[] }[] {
  return (["merge", "staged", "changes"] as ChangesSection[])
    .map((id) => ({ id, paths: getFilesForSection(snapshot, id).map((f) => f.path) }))
    .filter((g) => g.paths.length > 0);
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

describe("getFilesForSection — counted codes routed to Changes", () => {
  test("M, A, D, R, C, T, ? all land in the Changes section", () => {
    const s = snap({
      "a": "M", "b": "A", "c": "D", "d": "R", "e": "C", "f": "T", "g": "?",
    });
    const changes = getFilesForSection(s, "changes");
    expect(changes.length).toBe(7);
    expect(changes.map((f) => f.path).sort())
      .toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});

describe("getFilesForSection — BUG-007 exclusions", () => {
  test("'!' (ignored) is excluded from the Changes section", () => {
    const s = snap({ "a.ts": "M", "node_modules/x.js": "!" });
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["a.ts"]);
  });

  test("'·' (synthetic folder-dirty) is excluded from the Changes section", () => {
    const s = snap({ "real.ts": "M", "phantom-folder": "·" as unknown as GitShortCode });
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["real.ts"]);
  });

  test("a snapshot of ONLY ignored files yields an empty Changes section", () => {
    const s = snap({ "node_modules/a": "!", ".env.local": "!" });
    expect(getFilesForSection(s, "changes")).toEqual([]);
  });
});

describe("getFilesForSection — conflict routing (BUG-007 must not regress this)", () => {
  test("conflict paths go to Merge, NOT Changes", () => {
    const s = snap({ "conflict.ts": "U" }, ["conflict.ts"]);
    expect(getFilesForSection(s, "merge").map((f) => f.path)).toEqual(["conflict.ts"]);
    expect(getFilesForSection(s, "changes")).toEqual([]);
  });

  test("conflict path missing from fileStatus defaults to 'U'", () => {
    const s = snap({}, ["lost.ts"]);
    expect(getFilesForSection(s, "merge")).toEqual([{ path: "lost.ts", code: "U" }]);
  });

  test("conflict + ignored file: conflict→merge, ignored dropped, edit→changes", () => {
    const s = snap(
      { "conflict.ts": "U", "node_modules/x": "!", "edited.ts": "M" },
      ["conflict.ts"],
    );
    expect(getFilesForSection(s, "merge").map((f) => f.path)).toEqual(["conflict.ts"]);
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["edited.ts"]);
  });
});

describe("getFilesForSection — staged vs working partition", () => {
  test("staged files route to Staged; unstaged to Changes", () => {
    const s = snap({ "x.ts": "M", "y.ts": "A" }, [], { "x.ts": "M" });
    expect(getFilesForSection(s, "staged").map((f) => f.path)).toEqual(["x.ts"]);
    expect(getFilesForSection(s, "changes").map((f) => f.path)).toEqual(["y.ts"]);
  });
});

describe("buildGroups (derived) — group visibility", () => {
  test("merge group is hidden when there are no conflicts", () => {
    expect(buildGroups(snap({ "a": "M" })).find((g) => g.id === "merge")).toBeUndefined();
  });

  test("changes + staged groups are hidden when empty", () => {
    const groups = buildGroups(snap({}));
    expect(groups).toEqual([]);
  });
});
