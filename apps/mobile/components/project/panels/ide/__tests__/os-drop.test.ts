// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test";

import {
  collectDroppedEntries,
  isOsFileDrag,
  parentDirOf,
  resolveDropTarget,
} from "../os-drop";

interface FakeItem {
  kind?: "file" | "string";
  file?: File;
  entry?: FileSystemEntry | null;
}

function dataTransfer(opts: { items?: FakeItem[]; files?: File[]; types?: string[] }): DataTransfer {
  const items = (opts.items ?? []).map((it) => ({
    kind: it.kind ?? "file",
    type: it.file?.type ?? "",
    getAsFile: () => it.file ?? null,
    webkitGetAsEntry: () => it.entry ?? null,
  }));
  return {
    items,
    files: opts.files ?? items.map((i) => i.getAsFile()).filter((f): f is File => !!f),
    types: opts.types ?? ["Files"],
  } as unknown as DataTransfer;
}

function fileEntry(name: string, body = "x"): FileSystemEntry {
  const file = new File([body], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(file),
  } as unknown as FileSystemEntry;
}

/** A directory entry that yields `children` once, then an empty batch — which
 *  is exactly how the real `readEntries` signals "no more". */
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  let served = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok: (batch: FileSystemEntry[]) => void) => {
        if (served) {
          ok([]);
          return;
        }
        served = true;
        ok(children);
      },
    }),
  } as unknown as FileSystemEntry;
}

function row(attrs: { path: string; kind: "file" | "dir"; rootId?: string }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-tree-path", attrs.path);
  el.setAttribute("data-tree-kind", attrs.kind);
  el.setAttribute("data-tree-root", attrs.rootId ?? "agent");
  return el;
}

describe("isOsFileDrag", () => {
  test("a Files drag from the OS is an upload", () => {
    expect(isOsFileDrag(dataTransfer({ types: ["Files"] }))).toBe(true);
  });

  test("an in-app tree/tab drag is not", () => {
    expect(isOsFileDrag(dataTransfer({ types: ["application/x-ide-path", "Files"] }))).toBe(false);
  });

  test("a drag with no Files type is not", () => {
    expect(isOsFileDrag(dataTransfer({ types: ["text/plain"] }))).toBe(false);
  });

  test("a missing DataTransfer is not", () => {
    expect(isOsFileDrag(null)).toBe(false);
    expect(isOsFileDrag(undefined)).toBe(false);
  });
});

describe("parentDirOf", () => {
  test("splits on the last slash", () => {
    expect(parentDirOf("a.ts")).toBe("");
    expect(parentDirOf("src/a.ts")).toBe("src");
    expect(parentDirOf("src/deep/a.ts")).toBe("src/deep");
  });
});

describe("collectDroppedEntries", () => {
  test("a single dropped file keeps its name", async () => {
    const entries = await collectDroppedEntries(
      dataTransfer({ items: [{ entry: fileEntry("a.ts") }] }),
    );
    expect(entries.map((e) => e.path)).toEqual(["a.ts"]);
    expect(entries[0]!.file.name).toBe("a.ts");
  });

  test("a dropped folder is walked recursively into relative paths", async () => {
    const docs = dirEntry("docs", [
      fileEntry("a.md"),
      dirEntry("sub", [fileEntry("b.txt"), dirEntry("empty", [])]),
    ]);
    const entries = await collectDroppedEntries(dataTransfer({ items: [{ entry: docs }] }));
    expect(entries.map((e) => e.path)).toEqual(["docs/a.md", "docs/sub/b.txt"]);
  });

  test("several roots are collected in order", async () => {
    const entries = await collectDroppedEntries(
      dataTransfer({
        items: [
          { entry: fileEntry("one.ts") },
          { entry: dirEntry("pkg", [fileEntry("two.ts")]) },
        ],
      }),
    );
    expect(entries.map((e) => e.path)).toEqual(["one.ts", "pkg/two.ts"]);
  });

  test("falls back to dt.files when the drop has no items", async () => {
    const files = [new File(["x"], "a.ts"), new File(["y"], "b.ts")];
    const entries = await collectDroppedEntries(dataTransfer({ items: [], files }));
    expect(entries.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("falls back to the flat file when an item has no entry", async () => {
    const file = new File(["x"], "loose.ts");
    const entries = await collectDroppedEntries(
      dataTransfer({ items: [{ file, entry: null }], files: [file] }),
    );
    expect(entries.map((e) => e.path)).toEqual(["loose.ts"]);
  });

  test("an unreadable folder does not sink the rest of the drop", async () => {
    const broken = {
      isFile: false,
      isDirectory: true,
      name: "locked",
      createReader: () => ({
        readEntries: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error("denied")),
      }),
    } as unknown as FileSystemEntry;
    const entries = await collectDroppedEntries(
      dataTransfer({ items: [{ entry: broken }, { entry: fileEntry("ok.ts") }] }),
    );
    expect(entries.map((e) => e.path)).toEqual(["ok.ts"]);
  });

  test("string items are ignored", async () => {
    const entries = await collectDroppedEntries(
      dataTransfer({
        items: [{ kind: "string" }, { entry: fileEntry("a.ts") }],
      }),
    );
    expect(entries.map((e) => e.path)).toEqual(["a.ts"]);
  });
});

describe("resolveDropTarget", () => {
  test("a folder row is the destination", () => {
    const container = document.createElement("div");
    const folder = row({ path: "src/components", kind: "dir" });
    const label = document.createElement("span");
    folder.appendChild(label);
    container.appendChild(folder);
    expect(resolveDropTarget(label)).toEqual({ rootId: "agent", path: "src/components" });
  });

  test("a file row maps to its parent folder", () => {
    const file = row({ path: "src/components/Button.tsx", kind: "file" });
    expect(resolveDropTarget(file)).toEqual({ rootId: "agent", path: "src/components" });
  });

  test("a top-level file maps to the root", () => {
    expect(resolveDropTarget(row({ path: "README.md", kind: "file" }))).toEqual({
      rootId: "agent",
      path: "",
    });
  });

  test("the workspace root row maps to itself", () => {
    expect(resolveDropTarget(row({ path: "", kind: "dir" }))).toEqual({ rootId: "agent", path: "" });
  });

  test("a local root keeps its own id", () => {
    expect(resolveDropTarget(row({ path: "notes", kind: "dir", rootId: "local:abc" }))).toEqual({
      rootId: "local:abc",
      path: "notes",
    });
  });

  test("anything outside the tree is the workspace root", () => {
    expect(resolveDropTarget(document.createElement("div"))).toBeNull();
    expect(resolveDropTarget(null)).toBeNull();
  });
});
