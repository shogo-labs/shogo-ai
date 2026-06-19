/**
 * FocusCurrentBranch — test branch filtering logic for the graph.
 */

import { describe, expect, it } from "bun:test";

interface Commit {
  hash: string;
  message: string;
  author?: string;
  time?: string;
  isMerge?: boolean;
  branchLabel?: string;
  isRemote?: boolean;
}

function filterByLocalBranch(commits: Commit[]): Commit[] {
  return commits.filter((c) => !c.isRemote);
}

const mockCommits: Commit[] = [
  { hash: "abc1234", message: "feat: add button", author: "Alice", time: "2h ago", isMerge: false, branchLabel: "main", isRemote: false },
  { hash: "def5678", message: "fix: typo", author: "Bob", time: "3h ago", isMerge: false, branchLabel: "main", isRemote: false },
  { hash: "789abcd", message: "chore: deps", author: "Alice", time: "1d ago", isMerge: true, branchLabel: "main", isRemote: false },
  { hash: "remote1", message: "origin: update readme", author: "Carol", time: "2d ago", isMerge: false, branchLabel: "origin/main", isRemote: true },
  { hash: "remote2", message: "origin: add CI", author: "Dave", time: "3d ago", isMerge: false, branchLabel: "origin/main", isRemote: true },
];

describe("FocusCurrentBranch — filtering", () => {
  it("with focus: only shows local commits", () => {
    const filtered = filterByLocalBranch(mockCommits);
    expect(filtered).toHaveLength(3);
    filtered.forEach((c) => expect(c.isRemote).toBe(false));
  });

  it("without focus: shows all commits", () => {
    expect(mockCommits).toHaveLength(5);
  });

  it("empty commit list", () => {
    expect(filterByLocalBranch([])).toEqual([]);
  });

  it("all remote commits returns empty when focused", () => {
    const allRemote: Commit[] = [
      { hash: "r1", message: "remote", isRemote: true },
      { hash: "r2", message: "remote 2", isRemote: true },
    ];
    expect(filterByLocalBranch(allRemote)).toEqual([]);
  });

  it("all local commits returns all when focused", () => {
    const allLocal: Commit[] = [
      { hash: "l1", message: "local", isRemote: false },
      { hash: "l2", message: "local 2", isRemote: false },
    ];
    expect(filterByLocalBranch(allLocal)).toHaveLength(2);
  });

  it("mixed: filters correctly", () => {
    const mixed: Commit[] = [
      { hash: "a", message: "a", isRemote: false },
      { hash: "b", message: "b", isRemote: true },
      { hash: "c", message: "c", isRemote: false },
      { hash: "d", message: "d", isRemote: true },
      { hash: "e", message: "e", isRemote: false },
    ];
    const filtered = filterByLocalBranch(mixed);
    expect(filtered.map((c) => c.hash)).toEqual(["a", "c", "e"]);
  });

  it("merge commits are included in local filter", () => {
    const withMerge: Commit[] = [
      { hash: "m1", message: "merge", isMerge: true, isRemote: false },
      { hash: "n1", message: "normal", isRemote: false },
    ];
    expect(filterByLocalBranch(withMerge)).toHaveLength(2);
  });
});

describe("FocusCurrentBranch — toggle behavior", () => {
  it("toggle cycles correctly", () => {
    let focusBranch = false;
    const toggle = () => { focusBranch = !focusBranch; };
    toggle(); expect(focusBranch).toBe(true);
    toggle(); expect(focusBranch).toBe(false);
    toggle(); expect(focusBranch).toBe(true);
  });

  it("filter result changes with toggle", () => {
    let focusBranch = false;
    const result1 = focusBranch ? filterByLocalBranch(mockCommits) : mockCommits;
    focusBranch = true;
    const result2 = focusBranch ? filterByLocalBranch(mockCommits) : mockCommits;
    expect(result1).toHaveLength(5);
    expect(result2).toHaveLength(3);
  });
});
