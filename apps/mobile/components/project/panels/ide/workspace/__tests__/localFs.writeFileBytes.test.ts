// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-215 — `LocalFs.writeFileBytes`, the write an OS file drop uses when the
 * drop target is an "Add local folder" root.
 *
 * The File System Access API can't be driven from a test, so the handle tree
 * below is a stand-in with the same shape: `getDirectoryHandle(…, {create})`,
 * `getFileHandle(…, {create})` and `createWritable()`. What is being pinned is
 * the behaviour a drop depends on — the intermediate folders a dropped folder
 * tree needs are created, and the bytes reach the file without a text
 * round-trip (a PNG dropped into a local folder must not come out mangled).
 */
import { describe, expect, test } from "bun:test";

import { LocalFs } from "../localFs";

type FileNode = { kind: "file"; bytes: Uint8Array };
type DirNode = { kind: "dir"; children: Map<string, FileNode | DirNode> };

function dir(): DirNode {
  return { kind: "dir", children: new Map() };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Minimal `FileSystemDirectoryHandle` over the tree above. */
function dirHandle(node: DirNode): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      const existing = node.children.get(name);
      if (existing && existing.kind === "dir") return dirHandle(existing);
      if (existing) throw new Error(`TypeMismatchError: ${name} is a file`);
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      const created = dir();
      node.children.set(name, created);
      return dirHandle(created);
    },
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      const existing = node.children.get(name);
      if (existing && existing.kind === "dir") throw new Error(`TypeMismatchError: ${name}`);
      if (!existing && !opts?.create) throw new Error(`NotFoundError: ${name}`);
      return fileHandle(node, name);
    },
  } as unknown as FileSystemDirectoryHandle;
}

/** Minimal `FileSystemFileHandle`; `close()` is what commits the bytes. */
function fileHandle(parent: DirNode, name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    createWritable: async () => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk: Uint8Array) => {
          chunks.push(new Uint8Array(chunk));
        },
        close: async () => {
          parent.children.set(name, { kind: "file", bytes: concat(chunks) });
        },
      };
    },
  } as unknown as FileSystemFileHandle;
}

function service(): { fs: LocalFs; root: DirNode } {
  const root = dir();
  return { fs: new LocalFs("local:1", "My folder", dirHandle(root)), root };
}

function bytesAt(root: DirNode, path: string): Uint8Array | null {
  let node: DirNode = root;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    const next = node.children.get(part);
    if (!next || next.kind !== "dir") return null;
    node = next;
  }
  const file = node.children.get(parts[parts.length - 1]!);
  return file && file.kind === "file" ? file.bytes : null;
}

describe("LocalFs.writeFileBytes", () => {
  test("writes bytes that are not valid UTF-8 unchanged", async () => {
    const { fs, root } = service();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);

    await fs.writeFileBytes("logo.png", png);

    expect(Array.from(bytesAt(root, "logo.png") ?? [])).toEqual(Array.from(png));
  });

  test("creates the sub-folders a dropped folder tree needs", async () => {
    const { fs, root } = service();
    const bytes = new Uint8Array([1, 2, 3]);

    await fs.writeFileBytes("docs/sub/b.md", bytes);

    expect(Array.from(bytesAt(root, "docs/sub/b.md") ?? [])).toEqual([1, 2, 3]);
  });

  test("an existing file is overwritten, not appended to", async () => {
    const { fs, root } = service();

    await fs.writeFileBytes("a.txt", new Uint8Array([1, 1, 1]));
    await fs.writeFileBytes("a.txt", new Uint8Array([2]));

    expect(Array.from(bytesAt(root, "a.txt") ?? [])).toEqual([2]);
  });

  test("an empty path is refused instead of writing a nameless file", async () => {
    const { fs } = service();
    await expect(fs.writeFileBytes("", new Uint8Array([1]))).rejects.toThrow("Invalid path");
  });
});
