import { describe, expect, test } from "bun:test";
import { parseSession, sessionHasTabs, snapshotSession } from "../session";
import type { EditorGroup, OpenFile } from "../types";

const file = (path: string, extra: Partial<OpenFile> = {}): OpenFile => ({
  id: `agent::${path}`,
  rootId: "agent",
  name: path.split("/").pop()!,
  path,
  language: "typescript",
  content: "",
  savedContent: "",
  dirty: false,
  ...extra,
});

describe("session snapshot / parse", () => {
  test("round-trips paths and active tab, drops content", () => {
    const groups: EditorGroup[] = [
      { id: "g0", files: [file("a.ts", { content: "SECRET", pinned: true }), file("b.ts")], activeId: "agent::b.ts" },
    ];
    const snap = snapshotSession(groups, 0);
    const parsed = parseSession(JSON.stringify(snap))!;
    expect(parsed.groups[0].files).toEqual([
      { rootId: "agent", path: "a.ts", pinned: true },
      { rootId: "agent", path: "b.ts" },
    ]);
    expect(parsed.groups[0].activeId).toBe("agent::b.ts");
    expect(JSON.stringify(snap)).not.toContain("SECRET");
  });

  test("skips errored files and non-agent roots", () => {
    const groups: EditorGroup[] = [
      {
        id: "g0",
        files: [file("gone.ts", { error: "404" }), { ...file("x.ts"), rootId: "local-1" }, file("ok.ts")],
        activeId: null,
      },
    ];
    expect(snapshotSession(groups, 0).groups[0].files.map((f) => f.path)).toEqual(["ok.ts"]);
  });

  test("rejects garbage and clamps the active group", () => {
    expect(parseSession("nope")).toBeNull();
    expect(parseSession(JSON.stringify({ v: 2 }))).toBeNull();
    const p = parseSession(JSON.stringify({ v: 1, groups: [{ files: [], activeId: null }], activeGroupIdx: 9 }))!;
    expect(p.activeGroupIdx).toBe(0);
    expect(sessionHasTabs(p)).toBe(false);
  });
});

describe("pushRecent", () => {
  test("moves to front, dedupes, caps at 10", () => {
    const { pushRecent } = require("../session");
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(pushRecent(many, "new")).toHaveLength(10);
    expect(pushRecent(many, "new")[0]).toBe("new");
  });
});
