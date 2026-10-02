import { describe, expect, test } from "bun:test";
import { applyDirty, parseDirty, snapshotDirty } from "../hotExit";
import type { EditorGroup, OpenFile } from "../types";

const file = (path: string, content: string, saved: string, extra: Partial<OpenFile> = {}): OpenFile => ({
  id: `agent::${path}`, rootId: "agent", name: path, path, language: "typescript",
  content, savedContent: saved, dirty: content !== saved, ...extra,
});
const group = (files: OpenFile[]): EditorGroup => ({ id: "g", files, activeId: null });

describe("hot exit", () => {
  test("snapshot only includes dirty agent files", () => {
    const snap = snapshotDirty([group([file("a.ts", "x", "y"), file("b.ts", "same", "same"), file("c.ts", "x", "y", { rootId: "local" })])]);
    expect(snap).toEqual([{ path: "a.ts", content: "x", base: "y" }]);
  });
  test("skips oversized buffers", () => {
    const big = "z".repeat(500_000);
    expect(snapshotDirty([group([file("big.ts", big, "")])])).toEqual([]);
  });
  test("applies only when disk still matches the base", () => {
    const buffers = [{ path: "a.ts", content: "edited", base: "orig" }, { path: "b.ts", content: "edited", base: "orig" }];
    const files = [file("a.ts", "orig", "orig"), file("b.ts", "changed-on-disk", "changed-on-disk")];
    const { files: out, restored } = applyDirty(files, buffers);
    expect(restored).toBe(1);
    expect(out[0]).toMatchObject({ content: "edited", dirty: true, savedContent: "orig" });
    expect(out[1].dirty).toBe(false);
  });
  test("parseDirty tolerates junk", () => {
    expect(parseDirty("not json")).toEqual([]);
    expect(parseDirty(null)).toEqual([]);
    expect(parseDirty('[{"path":1}]')).toEqual([]);
  });
});
