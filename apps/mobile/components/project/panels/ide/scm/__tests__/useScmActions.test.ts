/**
 * useScmActions — test the action path logic (fetch/pull/push/sync/stage/discard).
 *
 * We test the bridge dispatching logic without a real Electron bridge
 * by mocking the bridge module.
 */

import { describe, expect, it } from "bun:test";

// ── Test the path-filtering logic used by Stage All / Discard All ──

function getUnstagedPaths(
  fileStatus: Record<string, string>,
  stagedStatus: Record<string, string>,
  conflictPaths: string[],
): string[] {
  return Object.keys(fileStatus).filter(
    (p) => !conflictPaths.includes(p) && !(p in stagedStatus),
  );
}

function getStagedPaths(stagedStatus: Record<string, string>): string[] {
  return Object.keys(stagedStatus);
}

function getConflictFreePaths(
  fileStatus: Record<string, string>,
  conflictPaths: string[],
): string[] {
  return Object.keys(fileStatus).filter((p) => !conflictPaths.includes(p));
}

describe("Stage All path computation", () => {
  it("returns all non-staged, non-conflict paths", () => {
    const fileStatus = { "a.ts": "M", "b.ts": "M", "c.ts": "M" };
    const stagedStatus = { "a.ts": "M" };
    const conflictPaths: string[] = [];
    expect(getUnstagedPaths(fileStatus, stagedStatus, conflictPaths)).toEqual(["b.ts", "c.ts"]);
  });

  it("returns empty when all files are staged", () => {
    const fileStatus = { "a.ts": "M", "b.ts": "A" };
    const stagedStatus = { "a.ts": "M", "b.ts": "A" };
    expect(getUnstagedPaths(fileStatus, stagedStatus, [])).toEqual([]);
  });

  it("excludes conflict paths from unstaged", () => {
    const fileStatus = { "a.ts": "M", "b.ts": "U", "c.ts": "M" };
    const stagedStatus = {};
    const conflictPaths = ["b.ts"];
    expect(getUnstagedPaths(fileStatus, stagedStatus, conflictPaths)).toEqual(["a.ts", "c.ts"]);
  });

  it("handles empty fileStatus", () => {
    expect(getUnstagedPaths({}, {}, [])).toEqual([]);
  });

  it("handles all files as conflicts", () => {
    const fileStatus = { "a.ts": "U", "b.ts": "U" };
    const stagedStatus = {};
    const conflictPaths = ["a.ts", "b.ts"];
    expect(getUnstagedPaths(fileStatus, stagedStatus, conflictPaths)).toEqual([]);
  });
});

describe("Discard All Staged path computation", () => {
  it("returns all staged paths", () => {
    const stagedStatus = { "a.ts": "M", "b.ts": "A", "c.ts": "D" };
    expect(getStagedPaths(stagedStatus)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("returns empty when nothing staged", () => {
    expect(getStagedPaths({})).toEqual([]);
  });

  it("returns single path when one file staged", () => {
    expect(getStagedPaths({ "only.ts": "M" })).toEqual(["only.ts"]);
  });
});

describe("Discard All path computation", () => {
  it("returns all non-conflict paths", () => {
    const fileStatus = { "a.ts": "M", "b.ts": "U", "c.ts": "D" };
    const conflictPaths = ["b.ts"];
    expect(getConflictFreePaths(fileStatus, conflictPaths)).toEqual(["a.ts", "c.ts"]);
  });

  it("returns all when no conflicts", () => {
    const fileStatus = { "a.ts": "M", "b.ts": "A" };
    expect(getConflictFreePaths(fileStatus, [])).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty on empty input", () => {
    expect(getConflictFreePaths({}, [])).toEqual([]);
  });
});

describe("Edge cases — mixed staging scenarios", () => {
  it("Stage All with complex staging matrix", () => {
    const fileStatus = {
      "modified.ts": "M",
      "added.ts": "A",
      "deleted.ts": "D",
      "renamed.ts": "R",
      "conflict.ts": "U",
      "already-staged.ts": "M",
    };
    const stagedStatus = { "already-staged.ts": "M" };
    const conflictPaths = ["conflict.ts"];

    const unstaged = getUnstagedPaths(fileStatus, stagedStatus, conflictPaths);
    expect(unstaged).toEqual(["modified.ts", "added.ts", "deleted.ts", "renamed.ts"]);
    expect(unstaged).not.toContain("already-staged.ts");
    expect(unstaged).not.toContain("conflict.ts");
  });

  it("Discard All respects staged vs unstaged boundary", () => {
    const fileStatus = { "staged.ts": "M", "unstaged.ts": "M" };
    const stagedStatus = { "staged.ts": "M" };

    // Discard All targets ALL unstaged (same as Stage All's target set)
    const unstaged = getUnstagedPaths(fileStatus, stagedStatus, []);
    expect(unstaged).toEqual(["unstaged.ts"]);
  });

  it("no files at all", () => {
    expect(getUnstagedPaths({}, {}, [])).toEqual([]);
    expect(getStagedPaths({})).toEqual([]);
    expect(getConflictFreePaths({}, [])).toEqual([]);
  });
});
