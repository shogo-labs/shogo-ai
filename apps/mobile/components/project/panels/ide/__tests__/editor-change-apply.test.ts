/**
 * Tests for applyEditorChange — the pure target-resolution helper that
 * underpins the BUG-001 fix (Monaco split-editor: stale model on rapid
 * tab swap).
 *
 * These tests assert the contract the helper exposes to Workbench:
 *   - the WRITE TARGET is always the explicit fileId, never the group's
 *     activeId (this is the whole point of the bug fix);
 *   - no-op writes return the same group reference (avoids needless
 *     React re-renders on flush echoes);
 *   - a missing fileId is silently dropped (closed mid-flight race);
 *   - dirty is re-derived from `val !== savedContent` so user reverts
 *     correctly drop the dirty marker.
 */
import { describe, expect, test } from "bun:test";
import { applyEditorChange } from "../editor-change-apply";
import type { EditorGroup, OpenFile } from "../types";

function file(id: string, content: string, savedContent = content, extra: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    rootId: "root",
    name: id,
    path: id,
    language: "typescript",
    content,
    savedContent,
    dirty: content !== savedContent,
    ...extra,
  };
}

function group(activeId: string | null, ...files: OpenFile[]): EditorGroup {
  return { id: "g", files, activeId };
}

describe("applyEditorChange — happy path", () => {
  test("updates the targeted file's content and marks it dirty", () => {
    const g = group("A", file("A", "old"), file("B", "B-content"));
    const next = applyEditorChange(g, "A", "new");
    expect(next).not.toBe(g);
    expect(next.files[0]!.content).toBe("new");
    expect(next.files[0]!.dirty).toBe(true);
    expect(next.files[1]).toBe(g.files[1]); // untouched file ref preserved
  });

  test("preserves other file props (pinned, language, name)", () => {
    const g = group("A", file("A", "x", "x", { pinned: true, language: "json", name: "config.json" }));
    const next = applyEditorChange(g, "A", "y");
    expect(next.files[0]!.pinned).toBe(true);
    expect(next.files[0]!.language).toBe("json");
    expect(next.files[0]!.name).toBe("config.json");
  });

  test("re-derives dirty=false when user reverts to savedContent", () => {
    const g = group("A", file("A", "edited", "saved"));
    expect(g.files[0]!.dirty).toBe(true);
    const next = applyEditorChange(g, "A", "saved");
    expect(next.files[0]!.dirty).toBe(false);
  });
});

describe("applyEditorChange — no-op short-circuits", () => {
  test("returns SAME group ref when value equals current content", () => {
    const g = group("A", file("A", "same"));
    const next = applyEditorChange(g, "A", "same");
    expect(next).toBe(g);
  });

  test("returns SAME group ref when fileId is not in group (closed mid-flight)", () => {
    const g = group("A", file("A", "x"));
    const next = applyEditorChange(g, "GHOST", "anything");
    expect(next).toBe(g);
  });

  test("returns SAME group ref on empty group", () => {
    const g = group(null);
    const next = applyEditorChange(g, "anything", "x");
    expect(next).toBe(g);
  });
});

describe("applyEditorChange — the BUG-001 stale-tab-swap scenario", () => {
  test("change for previously-active file lands on THAT file, not on activeId", () => {
    // Setup: user was editing A, just swapped to B. activeId=B now.
    // An in-flight Monaco onChange for A's model fires next.
    const g = group("B", file("A", "A-old"), file("B", "B-content"));
    const next = applyEditorChange(g, "A", "A-edited");

    // The change MUST land on A — not on whichever file activeId points at.
    expect(next.files[0]!.id).toBe("A");
    expect(next.files[0]!.content).toBe("A-edited");
    expect(next.files[0]!.dirty).toBe(true);

    // B (the now-active tab) MUST be untouched — same ref, same content.
    expect(next.files[1]).toBe(g.files[1]);
    expect(next.files[1]!.content).toBe("B-content");

    // activeId is not the helper's concern — it must NOT be mutated.
    expect(next.activeId).toBe("B");
  });

  test("matches the canvas BUG-001 scenario: two tabs reloading <50ms apart", () => {
    // T0: editing A.
    let g = group("A", file("A", "A0", "A0"), file("B", "B0", "B0"));
    g = applyEditorChange(g, "A", "A1");
    expect(g.files[0]!.content).toBe("A1");
    expect(g.files[0]!.dirty).toBe(true);

    // T+30ms: swap to B (parent flips activeId).
    g = { ...g, activeId: "B" };

    // T+45ms: stray onChange for A's model (Monaco hadn't yet detached when
    // user clicked). With the OLD activeId-based routing this would have
    // landed in B. With the new fileId-based routing it lands in A.
    g = applyEditorChange(g, "A", "A2");
    expect(g.files[0]!.content).toBe("A2");
    expect(g.files[1]!.content).toBe("B0"); // B untouched — proof the bug is fixed
    expect(g.files[1]!.dirty).toBe(false);

    // T+60ms: real edit on B.
    g = applyEditorChange(g, "B", "B1");
    expect(g.files[1]!.content).toBe("B1");
    expect(g.files[1]!.dirty).toBe(true);
  });
});
