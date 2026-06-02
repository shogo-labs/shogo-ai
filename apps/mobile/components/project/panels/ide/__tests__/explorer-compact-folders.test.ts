// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test";

import { buildCompactFolderChain } from "../explorer-compact-folders";
import type { TreeNode } from "../types";

function dir(path: string, children?: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode {
  const name = path === "" ? "workspace" : path.split("/").pop()!;
  return { rootId: "r", kind: "dir", name, path, children, ...extra };
}

function file(path: string): TreeNode {
  return { rootId: "r", kind: "file", name: path.split("/").pop()!, path };
}

describe("explorer compact folders", () => {
  test("leaves files unchanged", () => {
    const node = file("src/App.tsx");
    expect(buildCompactFolderChain(node)).toEqual({
      node,
      names: ["App.tsx"],
      label: "App.tsx",
      compacted: false,
    });
  });

  test("does not compact workspace root rows", () => {
    const node = dir("", [dir("src", [dir("src/components")])], { isRoot: true });
    const result = buildCompactFolderChain(node);
    expect(result.node).toBe(node);
    expect(result.label).toBe("workspace");
    expect(result.compacted).toBe(false);
  });

  test("collapses a single-child folder chain into the deepest directory", () => {
    const auth = dir("src/components/auth", [file("src/components/auth/Login.tsx")]);
    const components = dir("src/components", [auth]);
    const src = dir("src", [components]);

    const result = buildCompactFolderChain(src);

    expect(result.node).toBe(auth);
    expect(result.names).toEqual(["src", "components", "auth"]);
    expect(result.label).toBe("src/components/auth");
    expect(result.compacted).toBe(true);
  });

  test("stops before a directory with multiple children", () => {
    const src = dir("src", [
      dir("src/components", [file("src/components/Button.tsx")]),
      dir("src/lib", [file("src/lib/cn.ts")]),
    ]);

    const result = buildCompactFolderChain(src);

    expect(result.node).toBe(src);
    expect(result.label).toBe("src");
    expect(result.compacted).toBe(false);
  });

  test("stops when the only child is a file", () => {
    const src = dir("src", [file("src/App.tsx")]);
    const result = buildCompactFolderChain(src);
    expect(result.node).toBe(src);
    expect(result.label).toBe("src");
    expect(result.compacted).toBe(false);
  });

  test("stops at a lazy directory because descendants are unknown", () => {
    const modules = dir("node_modules", [], { lazy: true });
    const result = buildCompactFolderChain(modules);
    expect(result.node).toBe(modules);
    expect(result.label).toBe("node_modules");
    expect(result.compacted).toBe(false);
  });

  test("can compact into a lazy child but not beyond it", () => {
    const modules = dir("vendor/node_modules", [], { lazy: true });
    const vendor = dir("vendor", [modules]);
    const result = buildCompactFolderChain(vendor);
    expect(result.node).toBe(modules);
    expect(result.label).toBe("vendor/node_modules");
    expect(result.compacted).toBe(true);
  });

  test("does not compact through synthetic root children", () => {
    const childRoot = dir("nested-root", [dir("nested-root/src")], { isRoot: true });
    const node = dir("outer", [childRoot]);
    const result = buildCompactFolderChain(node);
    expect(result.node).toBe(node);
    expect(result.label).toBe("outer");
    expect(result.compacted).toBe(false);
  });

  test("preserves root ids and node identity for the represented directory", () => {
    const leaf = dir("a/b/c", [], { rootId: "local:1" });
    const b = dir("a/b", [leaf], { rootId: "local:1" });
    const a = dir("a", [b], { rootId: "local:1" });

    const result = buildCompactFolderChain(a);

    expect(result.node).toBe(leaf);
    expect(result.node.rootId).toBe("local:1");
  });
});
