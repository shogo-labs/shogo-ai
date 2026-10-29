// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";

import { FileTree, type FileTreeHandlers } from "../FileTree";
import type { TreeNode } from "../types";
import { CHAT_REFS_MIME, decodeChatDragPayload } from "../../../../../lib/chat-drag";

function dir(path: string, children: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode {
  const name = path === "" ? "agent-workspace" : path.split("/").pop()!;
  return { rootId: "agent", kind: "dir", name, path, children, ...extra };
}
function file(path: string, rootId = "agent"): TreeNode {
  return { rootId, kind: "file", name: path.split("/").pop()!, path };
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

function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    data,
    types: [] as string[],
    files: [] as File[],
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string, value: string) {
      data[type] = value;
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData: (type: string) => data[type] ?? "",
  };
}

const tree = () => [
  dir(
    "",
    [dir("src", [file("src/a.ts"), file("src/b.ts")]), file("README.md")],
    { isRoot: true },
  ),
];

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;
}

/** Fire a drag event whose `dataTransfer` is `dt` itself (RTL would copy it). */
function drag(kind: "dragStart" | "dragOver" | "drop" | "dragEnd", el: HTMLElement, dt: ReturnType<typeof dataTransfer>) {
  const event = createEvent[kind](el);
  Object.defineProperty(event, "dataTransfer", { value: dt });
  fireEvent(el, event);
}

afterEach(() => cleanup());

describe("FileTree drag to chat", () => {
  test("dragstart carries a chat reference payload for the node, and allows copy or move", () => {
    render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
    const dt = dataTransfer();
    drag("dragStart", row("README.md"), dt);
    expect(dt.effectAllowed).toBe("copyMove");
    expect(dt.data["application/x-ide-path"]).toBe("README.md");
    expect(decodeChatDragPayload(dt)).toEqual([{ kind: "file", path: "README.md", name: "README.md", rootId: "agent" }]);
  });

  test("dragging a node of a multi-selection drags the whole selection", () => {
    render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("a.ts"), { ctrlKey: true });
    fireEvent.click(screen.getByText("README.md"), { ctrlKey: true });
    const dt = dataTransfer();
    drag("dragStart", row("README.md"), dt);
    // Ctrl-click extends from the focused row ("src"), as in VS Code.
    expect(decodeChatDragPayload(dt)?.map((i) => i.path).sort()).toEqual(["README.md", "src", "src/a.ts"]);
  });

  test("ctrl-click after opening a file keeps that file in the selection", () => {
    const h = handlers();
    const { rerender } = render(<FileTree tree={tree()} activePath={null} handlers={h} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("a.ts"));
    // The workbench opens the file; auto-reveal of the new active editor resets the multi-selection.
    rerender(<FileTree tree={tree()} activePath="src/a.ts" handlers={h} />);
    fireEvent.click(screen.getByText("b.ts"), { ctrlKey: true });
    const dt = dataTransfer();
    drag("dragStart", row("b.ts"), dt);
    expect(decodeChatDragPayload(dt)?.map((i) => i.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("dragging an unselected node drags only that node", () => {
    render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("a.ts"), { ctrlKey: true });
    fireEvent.click(screen.getByText("README.md"), { ctrlKey: true });
    const dt = dataTransfer();
    drag("dragStart", row("b.ts"), dt);
    expect(decodeChatDragPayload(dt)?.map((i) => i.path)).toEqual(["src/b.ts"]);
  });

  test("folders are dragged as folder references", () => {
    render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
    const dt = dataTransfer();
    drag("dragStart", row("src"), dt);
    expect(decodeChatDragPayload(dt)).toEqual([{ kind: "folder", path: "src", name: "src", rootId: "agent" }]);
  });

  test("in-tree moves still work", () => {
    const onMove = mock(async () => {});
    render(<FileTree tree={tree()} activePath={null} handlers={handlers({ onMove })} />);
    const dt = dataTransfer();
    drag("dragStart", row("README.md"), dt);
    drag("dragOver", row("src"), dt);
    expect(dt.dropEffect).toBe("move");
    drag("drop", row("src"), dt);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect((onMove.mock.calls[0] as any)[0].path).toBe("README.md");
    expect((onMove.mock.calls[0] as any)[1].path).toBe("src");
  });

  test("a drop on the chat (dropEffect copy) of a dirty file reports unsaved changes", () => {
    const onDraggedToChatWithUnsaved = mock((_names: string[]) => {});
    render(
      <FileTree
        tree={tree()}
        activePath={null}
        handlers={handlers({ isDirty: (_root, path) => path === "README.md", onDraggedToChatWithUnsaved })}
      />,
    );
    const dt = dataTransfer();
    drag("dragStart", row("README.md"), dt);
    expect(decodeChatDragPayload(dt)?.[0].dirty).toBe(true);
    dt.dropEffect = "copy";
    drag("dragEnd", row("README.md"), dt);
    expect(onDraggedToChatWithUnsaved).toHaveBeenCalledWith(["README.md"]);
  });

  test("an in-tree move of a dirty file does not report unsaved changes", () => {
    const onDraggedToChatWithUnsaved = mock((_names: string[]) => {});
    render(
      <FileTree tree={tree()} activePath={null} handlers={handlers({ isDirty: () => true, onDraggedToChatWithUnsaved })} />,
    );
    const dt = dataTransfer();
    drag("dragStart", row("README.md"), dt);
    dt.dropEffect = "move";
    drag("dragEnd", row("README.md"), dt);
    expect(onDraggedToChatWithUnsaved).not.toHaveBeenCalled();
  });
});

describe("FileTree Add to Chat menu", () => {
  test("the single-node menu starts with Add to Chat and calls onAddToChat", () => {
    const onAddToChat = mock((_nodes: TreeNode[]) => {});
    render(<FileTree tree={tree()} activePath={null} handlers={handlers({ onAddToChat })} />);
    fireEvent.contextMenu(row("README.md"));
    const items = screen.getAllByRole("menu")[0].querySelectorAll("button");
    expect(items[0].textContent).toContain("Add to Chat");
    fireEvent.click(items[0]);
    expect(onAddToChat).toHaveBeenCalledTimes(1);
    expect(onAddToChat.mock.calls[0][0].map((n: TreeNode) => n.path)).toEqual(["README.md"]);
  });

  test("the multi-selection menu adds the whole selection", () => {
    const onAddToChat = mock((_nodes: TreeNode[]) => {});
    render(<FileTree tree={tree()} activePath={null} handlers={handlers({ onAddToChat })} />);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("a.ts"), { ctrlKey: true });
    fireEvent.click(screen.getByText("b.ts"), { ctrlKey: true });
    fireEvent.contextMenu(row("b.ts"));
    fireEvent.click(screen.getByText("Add to Chat"));
    expect(onAddToChat.mock.calls[0][0].map((n: TreeNode) => n.path).sort()).toEqual(["src", "src/a.ts", "src/b.ts"]);
  });

  test("disabled with a hint for files outside the agent workspace", () => {
    const onAddToChat = mock((_nodes: TreeNode[]) => {});
    const local = [dir("", [file("notes.md", "local:repo:1")], { isRoot: true, rootId: "local:repo:1", name: "repo" })];
    render(<FileTree tree={local} activePath={null} handlers={handlers({ onAddToChat })} />);
    fireEvent.contextMenu(row("notes.md"));
    const item = screen.getByText("Add to Chat").closest("button")!;
    expect(item.disabled).toBe(true);
    expect(item.getAttribute("title")).toBe("Only project workspace files can be referenced");
    expect(screen.getByText("Only project workspace files can be referenced")).toBeTruthy();
  });

  test("no Add to Chat entry without a handler", () => {
    render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
    fireEvent.contextMenu(row("README.md"));
    expect(screen.queryByText("Add to Chat")).toBeNull();
  });

  test("reports the selection for palette commands", () => {
    const onSelectionChange = mock((_nodes: TreeNode[]) => {});
    render(<FileTree tree={tree()} activePath={null} handlers={handlers({ onSelectionChange })} />);
    fireEvent.click(screen.getByText("README.md"));
    const last = onSelectionChange.mock.calls.at(-1)![0];
    expect(last.map((n: TreeNode) => n.path)).toEqual(["README.md"]);
  });
});

test("the payload uses the chat reference MIME type", () => {
  render(<FileTree tree={tree()} activePath={null} handlers={handlers()} />);
  const dt = dataTransfer();
  drag("dragStart", row("README.md"), dt);
  expect(dt.types).toContain(CHAT_REFS_MIME);
});
