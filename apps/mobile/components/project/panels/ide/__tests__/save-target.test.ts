/**
 * save-target.ts — BUG-003 fileId-keyed save-target resolution.
 *
 * These tests lock the contract that makes the rest of the BUG-003 fix
 * safe:
 *   1. Resolution is by fileId across ALL groups (split-view safe).
 *   2. Missing fileId returns null — the canonical "closed mid-flight"
 *      semantic the save path drops silently.
 *   3. Save-All deduplicates by fileId — the same file open in two split
 *      groups must not be written twice.
 *   4. The function returns the LATEST snapshot from the provided
 *      `groups` array (it's a ref-read, NOT a closure capture). The tests
 *      simulate a rapid-tab-swap-after-Cmd+S scenario to assert this.
 */
import { describe, expect, test } from "bun:test";
import { collectDirtyFiles, resolveSaveTarget } from "../save-target";
import type { EditorGroup, OpenFile } from "../types";

function file(id: string, content = "", savedContent = content, dirty = false): OpenFile {
  return {
    id, rootId: "root", name: id, path: id, language: "ts",
    content, savedContent, dirty,
  };
}
function group(activeId: string | null, ...files: OpenFile[]): EditorGroup {
  return { id: `g-${activeId ?? "none"}`, files, activeId };
}

describe("resolveSaveTarget — fileId routing", () => {
  test("returns the file with matching id from the first group", () => {
    const g = [group("A", file("A", "hello"), file("B"))];
    expect(resolveSaveTarget(g, "A")?.content).toBe("hello");
  });

  test("returns the file from a non-active group (split-view)", () => {
    const g = [group("A", file("A")), group("B", file("B", "right-pane"))];
    expect(resolveSaveTarget(g, "B")?.content).toBe("right-pane");
  });

  test("returns null when fileId is not present (closed mid-flight)", () => {
    const g = [group("A", file("A"))];
    expect(resolveSaveTarget(g, "GHOST")).toBeNull();
  });

  test("returns null on empty groups array", () => {
    expect(resolveSaveTarget([], "A")).toBeNull();
  });

  test("returns null on a group with no files", () => {
    expect(resolveSaveTarget([group(null)], "A")).toBeNull();
  });

  test("explicitly does NOT depend on activeId — that's the BUG-003 fix", () => {
    // groups have activeId pointing at B, but Cmd+S was pressed for A.
    // resolveSaveTarget must return A — the bug was that the old code
    // used the React-state active OpenFile which would have been B.
    const g = [group("B", file("A", "save-me"), file("B", "skip-me"))];
    expect(resolveSaveTarget(g, "A")?.content).toBe("save-me");
  });

  test("returns the LATEST snapshot — simulating ref-read after tab swap", () => {
    // T0 (Cmd+S pressed): user was editing A with content="v1".
    // T+5ms (between keystroke and async save callback): user typed more,
    //   so groupsRef now holds A.content="v2".
    // resolveSaveTarget must return v2 — the bug was that the old code
    // captured `active` (with v1) in a useCallback closure.
    const latest = [group("A", file("A", "v2"))];
    expect(resolveSaveTarget(latest, "A")?.content).toBe("v2");
  });
});

describe("collectDirtyFiles — Save All", () => {
  test("returns only dirty files", () => {
    const g = [group("A", file("A", "x", "x", false), file("B", "y", "x", true))];
    const dirty = collectDirtyFiles(g);
    expect(dirty.map((f) => f.id)).toEqual(["B"]);
  });

  test("flattens across groups", () => {
    const g = [
      group("A", file("A", "1", "0", true)),
      group("B", file("B", "2", "0", true)),
    ];
    expect(collectDirtyFiles(g).map((f) => f.id).sort()).toEqual(["A", "B"]);
  });

  test("deduplicates by fileId across groups (same file in two split panes)", () => {
    // Same file id, open in both groups. Must only appear ONCE in the
    // save-all batch — otherwise we'd issue two FS writes for one file.
    const sharedDirty = file("shared", "v", "saved", true);
    const g = [group("shared", sharedDirty), group("shared", sharedDirty)];
    const dirty = collectDirtyFiles(g);
    expect(dirty.length).toBe(1);
    expect(dirty[0]!.id).toBe("shared");
  });

  test("returns empty array when nothing is dirty", () => {
    const g = [group("A", file("A", "x", "x", false))];
    expect(collectDirtyFiles(g)).toEqual([]);
  });

  test("returns empty array on empty groups", () => {
    expect(collectDirtyFiles([])).toEqual([]);
  });
});
