// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FileTree, type FileTreeHandlers } from "../FileTree";
import type { TreeNode } from "../types";

function dir(path: string, children?: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode {
  const name = path === "" ? "agent-workspace" : path.split("/").pop()!;
  return { rootId: "agent", kind: "dir", name, path, children, ...extra };
}

function file(path: string): TreeNode {
  return { rootId: "agent", kind: "file", name: path.split("/").pop()!, path };
}

function handlers(overrides: Partial<FileTreeHandlers> = {}): FileTreeHandlers {
  return {
    onOpen: mock(() => {}),
    onCreate: mock(async () => {}),
    onRename: mock(async () => {}),
    onDelete: mock(async () => {}),
    onMove: mock(async () => {}),
    onDownload: mock(() => {}),
    ...overrides,
  };
}

function renderTree(tree: TreeNode[], overrides: Partial<FileTreeHandlers> = {}) {
  const h = handlers(overrides);
  const result = render(
    <FileTree
      tree={tree}
      activePath={null}
      handlers={h}
    />,
  );
  return { ...result, handlers: h };
}

afterEach(() => cleanup());

describe("FileTree compact folders", () => {
  test("renders a single-child folder chain as one compact row", () => {
    const tree = [
      dir("", [
        dir("src", [
          dir("src/components", [
            dir("src/components/auth", [file("src/components/auth/Login.tsx")]),
          ]),
        ]),
      ], { isRoot: true }),
    ];

    renderTree(tree);

    expect(screen.getByText("agent-workspace")).toBeTruthy();
    const compact = screen.getByText("src/components/auth");
    expect(compact).toBeTruthy();
    expect(compact.getAttribute("title")).toBe("src/components/auth");
    expect(screen.queryByText("src")).toBeNull();
    expect(screen.queryByText("components")).toBeNull();
    expect(screen.queryByText("auth")).toBeNull();
    expect(screen.queryByText("Login.tsx")).toBeNull();
  });

  test("expands the represented deepest directory and opens children with original paths", () => {
    const onOpen = mock(() => {});
    const tree = [
      dir("", [
        dir("src", [
          dir("src/components", [
            dir("src/components/auth", [file("src/components/auth/Login.tsx")]),
          ]),
        ]),
      ], { isRoot: true }),
    ];

    renderTree(tree, { onOpen });

    fireEvent.click(screen.getByText("src/components/auth"));
    fireEvent.click(screen.getByText("Login.tsx"));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0].path).toBe("src/components/auth/Login.tsx");
  });

  test("does not compact folders that have multiple children", () => {
    const tree = [
      dir("", [
        dir("src", [
          dir("src/components", [file("src/components/Button.tsx")]),
          dir("src/lib", [file("src/lib/cn.ts")]),
        ]),
      ], { isRoot: true }),
    ];

    renderTree(tree);

    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText("src/components")).toBeNull();
    expect(screen.queryByText("src/lib")).toBeNull();
  });

  test("compacts each branch independently after a branching point is expanded", () => {
    const tree = [
      dir("", [
        dir("src", [
          dir("src/components", [dir("src/components/ui", [file("src/components/ui/Button.tsx")])]),
          dir("src/features", [dir("src/features/auth", [file("src/features/auth/Login.tsx")])]),
        ]),
      ], { isRoot: true }),
    ];

    renderTree(tree);

    fireEvent.click(screen.getByText("src"));

    expect(screen.getByText("components/ui")).toBeTruthy();
    expect(screen.getByText("features/auth")).toBeTruthy();
  });

  test("lazy compact child loads using the represented directory path", async () => {
    const onLoadSubtree = mock(async () => {});
    const tree = [
      dir("", [
        dir("vendor", [dir("vendor/node_modules", [], { lazy: true })]),
      ], { isRoot: true }),
    ];

    renderTree(tree, { onLoadSubtree });

    await act(async () => {
      fireEvent.click(screen.getByText("vendor/node_modules"));
      await Promise.resolve();
    });

    expect(onLoadSubtree).toHaveBeenCalledTimes(1);
    expect(onLoadSubtree.mock.calls[0]).toEqual(["agent", "vendor/node_modules"]);
  });

  test("ArrowLeft from a child selects the visible compact parent, not a hidden intermediate", () => {
    const tree = [
      dir("", [
        dir("src", [
          dir("src/components", [
            dir("src/components/auth", [file("src/components/auth/Login.tsx")]),
          ]),
        ]),
      ], { isRoot: true }),
    ];

    const { container } = renderTree(tree);

    fireEvent.click(screen.getByText("src/components/auth"));
    fireEvent.click(screen.getByText("Login.tsx"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(screen.queryByText("Login.tsx")).toBeNull();
    expect(container.textContent).toContain("src/components/auth");
  });
});
