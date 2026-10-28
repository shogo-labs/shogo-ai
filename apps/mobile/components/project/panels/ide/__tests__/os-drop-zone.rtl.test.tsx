// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-215 — the IDE-level OS-file drop zone.
 *
 * The tree rows no longer carry their own upload handlers: one capture-phase
 * zone on the IDE root decides where a drop lands. These tests pin the two
 * halves of that contract — a `Files` drop anywhere in the IDE reaches the
 * upload handler with the right destination, and an in-app drag
 * (`application/x-ide-path`) never does.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { useOsFileDrop } from "../os-drop-zone";
import type { DropDestination, DroppedEntry } from "../os-drop";

function dataTransfer(opts: { types?: string[]; name?: string; folder?: string[] } = {}): DataTransfer {
  const types = opts.types ?? ["Files"];
  const entries: DroppedEntry[] = [];
  const items = (opts.folder ?? [opts.name ?? "dropped.ts"]).map((name) => {
    const file = new File(["x"], name);
    entries.push({ path: name, file });
    return {
      kind: "file" as const,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({
        isFile: true,
        isDirectory: false,
        name,
        file: (ok: (f: File) => void) => ok(file),
      }),
    };
  });
  return { types, items, files: entries.map((e) => e.file) } as unknown as DataTransfer;
}

function Harness({
  onDrop,
  enabled = true,
}: {
  onDrop: (entries: DroppedEntry[], dest: DropDestination | null) => void;
  enabled?: boolean;
}) {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const { active } = useOsFileDrop({ scopeRef, onDrop, enabled });
  return (
    <div ref={scopeRef} data-testid="ide">
      <div data-tree-path="src" data-tree-kind="dir" data-tree-root="agent" data-testid="folder">
        src
      </div>
      <div
        data-tree-path="src/a.ts"
        data-tree-kind="file"
        data-tree-root="agent"
        data-testid="file-row"
      >
        a.ts
      </div>
      <div data-testid="editor">editor</div>
      {active && <div data-testid="overlay">Drop to upload</div>}
    </div>
  );
}

function renderZone(opts: { enabled?: boolean } = {}) {
  const onDrop = mock((_entries: DroppedEntry[], _dest: DropDestination | null) => {});
  render(<Harness onDrop={onDrop} enabled={opts.enabled} />);
  return { onDrop };
}

afterEach(() => cleanup());

describe("useOsFileDrop", () => {
  test("dropping on the editor area uploads to the workspace root", async () => {
    const { onDrop } = renderZone();
    fireEvent.drop(screen.getByTestId("editor"), { dataTransfer: dataTransfer() });

    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    const [entries, dest] = onDrop.mock.calls[0] as [DroppedEntry[], DropDestination | null];
    expect(entries.map((e) => e.path)).toEqual(["dropped.ts"]);
    expect(dest).toBeNull();
  });

  test("dropping on a folder row uploads into that folder", async () => {
    const { onDrop } = renderZone();
    fireEvent.drop(screen.getByTestId("folder"), { dataTransfer: dataTransfer() });

    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect((onDrop.mock.calls[0] as [DroppedEntry[], DropDestination | null])[1]).toEqual({ rootId: "agent", path: "src" });
  });

  test("dropping on a file row uploads into its parent folder", async () => {
    const { onDrop } = renderZone();
    fireEvent.drop(screen.getByTestId("file-row"), { dataTransfer: dataTransfer() });

    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect((onDrop.mock.calls[0] as [DroppedEntry[], DropDestination | null])[1]).toEqual({ rootId: "agent", path: "src" });
  });

  test("a nested folder tree arrives with its relative paths", async () => {
    const { onDrop } = renderZone();
    fireEvent.drop(screen.getByTestId("editor"), {
      dataTransfer: dataTransfer({ folder: ["docs/a.md", "docs/sub/b.md"] }),
    });

    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect((onDrop.mock.calls[0] as [DroppedEntry[], DropDestination | null])[0].map((e) => e.path)).toEqual(["docs/a.md", "docs/sub/b.md"]);
  });

  test("an in-app tree drag is left alone", async () => {
    const { onDrop } = renderZone();
    const dt = dataTransfer({ types: ["application/x-ide-path", "Files"] });
    fireEvent.dragOver(screen.getByTestId("editor"), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId("editor"), { dataTransfer: dt });

    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  test("the overlay shows over the editor and hides over a folder row", async () => {
    renderZone();
    const editor = screen.getByTestId("editor");

    fireEvent.dragOver(editor, { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.getByTestId("overlay")).toBeTruthy());

    fireEvent.dragOver(screen.getByTestId("folder"), { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.queryByTestId("overlay")).toBeNull());
  });

  test("a drop clears the overlay", async () => {
    renderZone();
    const editor = screen.getByTestId("editor");
    fireEvent.dragOver(editor, { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.getByTestId("overlay")).toBeTruthy());

    fireEvent.drop(editor, { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.queryByTestId("overlay")).toBeNull());
  });

  test("drops outside the IDE subtree are not hijacked", async () => {
    const { onDrop } = renderZone();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.drop(outside, { dataTransfer: dataTransfer() });

    expect(onDrop).not.toHaveBeenCalled();
    outside.remove();
  });

  test("nothing is captured while the pane is hidden", async () => {
    const { onDrop } = renderZone({ enabled: false });
    const editor = screen.getByTestId("editor");
    fireEvent.dragOver(editor, { dataTransfer: dataTransfer() });
    fireEvent.drop(editor, { dataTransfer: dataTransfer() });

    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overlay")).toBeNull();
  });
});
