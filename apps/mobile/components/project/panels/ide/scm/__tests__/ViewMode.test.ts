/**
 * Tree-view construction (the behaviour behind the list/tree toggle).
 *
 * This file previously asserted on inline copies of constants (e.g.
 * `expect(intervalMs).toBe(30_000)` right after assigning it) — tautologies
 * that tested nothing. It now drives the REAL exported `buildChangesTree`
 * that ChangesList renders in tree mode, so a regression in the tree grouping,
 * single-child compaction, or sort order is actually caught.
 */
import { describe, expect, it } from "bun:test";
import { buildChangesTree } from "../grouping";
import type { GitShortCode } from "../../git/bridge";

type Node =
  | { type: "file"; name: string; file: { path: string } }
  | { type: "dir"; name: string; path: string; children: Node[] };

function file(path: string, code: GitShortCode = "M") {
  return { path, code };
}

function asNodes(files: ReturnType<typeof file>[]): Node[] {
  return buildChangesTree(files) as unknown as Node[];
}

describe("buildChangesTree", () => {
  it("returns an empty tree for no files", () => {
    expect(asNodes([])).toEqual([]);
  });

  it("keeps root-level files flat", () => {
    const nodes = asNodes([file("a.ts"), file("b.ts")]);
    expect(nodes.every((n) => n.type === "file")).toBe(true);
    expect(nodes.map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("nests files under their directory", () => {
    const nodes = asNodes([file("src/index.ts"), file("src/util.ts")]);
    expect(nodes).toHaveLength(1);
    const dir = nodes[0];
    expect(dir.type).toBe("dir");
    if (dir.type !== "dir") throw new Error("expected dir");
    expect(dir.name).toBe("src");
    expect(dir.children.map((c) => c.name)).toEqual(["index.ts", "util.ts"]);
  });

  it("compacts single-child directory chains (src/components → one node)", () => {
    const nodes = asNodes([file("src/components/Button.tsx")]);
    expect(nodes).toHaveLength(1);
    const dir = nodes[0];
    if (dir.type !== "dir") throw new Error("expected dir");
    expect(dir.name).toBe("src/components");
    expect(dir.children).toHaveLength(1);
    expect(dir.children[0].name).toBe("Button.tsx");
  });

  it("does NOT compact a directory that has multiple children", () => {
    const nodes = asNodes([file("src/a.ts"), file("src/sub/b.ts")]);
    const src = nodes[0];
    if (src.type !== "dir") throw new Error("expected dir");
    expect(src.name).toBe("src");
    // src has a file (a.ts) and a dir (sub) → not collapsible.
    expect(src.children.map((c) => c.name).sort()).toEqual(["a.ts", "sub"]);
  });

  it("sorts directories before files, each alphabetically", () => {
    const nodes = asNodes([file("z.ts"), file("a.ts"), file("dir/x.ts")]);
    // dir first (it's a directory), then files alphabetically.
    expect(nodes.map((n) => `${n.type}:${n.name}`)).toEqual([
      "dir:dir",
      "file:a.ts",
      "file:z.ts",
    ]);
  });
});
