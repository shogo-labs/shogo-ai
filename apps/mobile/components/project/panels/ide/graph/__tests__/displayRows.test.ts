// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from "bun:test";

import type { GitGraphCommit, GitStatus } from "@shogo/shared-app/hooks";

import { buildDisplayRows } from "../displayRows";

function commit(sha: string, parents: string[]): GitGraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    refs: [],
    subject: `commit ${sha}`,
    body: "",
    author: "Dev",
    authorEmail: "dev@example.com",
    committer: "Dev",
    committerEmail: "dev@example.com",
    date: "2026-06-02T00:00:00.000Z",
    coAuthors: [],
  };
}

const cleanStatus: GitStatus = {
  isRepo: true,
  branch: "main",
  headSha: "c",
  staged: [],
  unstaged: [],
  untracked: [],
  hasChanges: false,
};

describe("buildDisplayRows", () => {
  it("flags only the commits that correspond to checkpoints", () => {
    const commits = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
    const { rows } = buildDisplayRows(commits, cleanStatus, new Set(["b"]));

    expect(rows.map((r) => r.sha)).toEqual(["c", "b", "a"]);
    expect(rows.map((r) => r.isCheckpoint)).toEqual([false, true, false]);
  });

  it("marks no rows when there are no checkpoints", () => {
    const commits = [commit("c", ["b"]), commit("b", [])];
    const { rows } = buildDisplayRows(commits, cleanStatus, new Set());
    expect(rows.every((r) => !r.isCheckpoint)).toBe(true);
  });

  it("flags only the live commit when a liveSha is given", () => {
    const commits = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
    const { rows } = buildDisplayRows(commits, cleanStatus, new Set(["b"]), "b");

    expect(rows.map((r) => r.isLive)).toEqual([false, true, false]);
    // Live + checkpoint are independent flags that can co-exist on one commit.
    expect(rows.find((r) => r.sha === "b")?.isCheckpoint).toBe(true);
  });

  it("marks no rows live when liveSha is absent", () => {
    const commits = [commit("c", ["b"]), commit("b", [])];
    const { rows } = buildDisplayRows(commits, cleanStatus, new Set(["c"]));
    expect(rows.every((r) => !r.isLive)).toBe(true);
  });

  it("prepends a non-checkpoint WIP row when the working tree is dirty", () => {
    const commits = [commit("c", ["b"]), commit("b", [])];
    const dirty: GitStatus = {
      ...cleanStatus,
      hasChanges: true,
      unstaged: ["src/a.ts", "src/b.ts"],
      untracked: ["src/c.ts"],
    };

    const { rows } = buildDisplayRows(commits, dirty, new Set(["c"]));

    expect(rows[0].kind).toBe("wip");
    expect(rows[0].isCheckpoint).toBe(false);
    expect(rows[0].wipCount).toBe(3);
    // The real head commit still follows and keeps its checkpoint flag.
    expect(rows[1].sha).toBe("c");
    expect(rows[1].isCheckpoint).toBe(true);
  });

  it("does not add a WIP row when there are no commits", () => {
    const dirty: GitStatus = { ...cleanStatus, hasChanges: true, unstaged: ["x"] };
    const { rows } = buildDisplayRows([], dirty, new Set());
    expect(rows).toEqual([]);
  });

  it("widens to two lanes for a branch + merge and keeps checkpoint flags aligned", () => {
    const commits = [
      commit("m", ["b", "f"]),
      commit("f", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ];
    const { rows, maxLanes } = buildDisplayRows(commits, cleanStatus, new Set(["f"]));

    expect(maxLanes).toBe(2);
    const fRow = rows.find((r) => r.sha === "f");
    expect(fRow?.isCheckpoint).toBe(true);
    expect(rows.find((r) => r.sha === "m")?.isCheckpoint).toBe(false);
  });
});
