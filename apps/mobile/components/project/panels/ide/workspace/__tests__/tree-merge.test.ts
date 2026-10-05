import { describe, expect, test } from "bun:test";
import { mergeDirChildren, nearestLoadedDir, parentDir } from "../tree-merge";
import type { TreeNode } from "../../types";

const f = (path: string): TreeNode => ({ name: path.split("/").pop()!, path, kind: "file", rootId: "agent" });
const d = (path: string, children?: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode => ({
  name: path.split("/").pop()!, path, kind: "dir", rootId: "agent", ...(children ? { children } : {}), ...extra,
});

describe("mergeDirChildren", () => {
  test("keeps loaded subtree when fresh listing has a stub", () => {
    const old = [d("a", [d("a/deep", [f("a/deep/x.ts")])])];
    const fresh = [d("a", undefined, { lazy: true }), f("new.ts")];
    const out = mergeDirChildren(old, fresh);
    expect(out[0].children?.[0].children?.[0].path).toBe("a/deep/x.ts");
    expect(out[0].lazy).toBeUndefined();
    expect(out[1].path).toBe("new.ts");
  });
  test("drops deleted entries and adds new ones", () => {
    const out = mergeDirChildren([f("gone.ts"), f("keep.ts")], [f("keep.ts"), f("added.ts")]);
    expect(out.map((n) => n.path)).toEqual(["keep.ts", "added.ts"]);
  });
  test("recurses into dirs present on both sides", () => {
    const old = [d("a", [d("a/b", [f("a/b/x.ts")]), f("a/old.ts")])];
    const fresh = [d("a", [d("a/b", undefined, { lazy: true }), f("a/new.ts")])];
    const out = mergeDirChildren(old, fresh);
    expect(out[0].children?.map((n) => n.path)).toEqual(["a/b", "a/new.ts"]);
    expect(out[0].children?.[0].children?.[0].path).toBe("a/b/x.ts");
  });
});

describe("nearestLoadedDir / parentDir", () => {
  const tree = [d("src", [d("src/a", [f("src/a/x.ts")]), d("src/lazy", undefined, { lazy: true })])];
  test("loaded dir returns itself", () => expect(nearestLoadedDir(tree, "src/a")).toBe("src/a"));
  test("new/unloaded dir climbs to loaded ancestor", () => {
    expect(nearestLoadedDir(tree, "src/a/newdir")).toBe("src/a");
    expect(nearestLoadedDir(tree, "src/lazy/inner")).toBe("src");
  });
  test("unknown top-level climbs to root", () => expect(nearestLoadedDir(tree, "other/x")).toBe(""));
  test("parentDir", () => {
    expect(parentDir("a/b/c.ts")).toBe("a/b");
    expect(parentDir("c.ts")).toBe("");
  });
});
