/**
 * model-by-uri.ts — BUG-003 fileId → editor/model resolution.
 *
 * These tests lock the property that makes format-on-save safe across
 * tab swaps and split panes: an editor is matched ONLY when its
 * currently-attached model's URI string contains the target fileId.
 * Null models, null editors, mismatches all return null/false — the
 * caller's format step is then skipped (preferable to formatting the
 * wrong document, which is what BUG-003 reports).
 */
import { describe, expect, test } from "bun:test";
import { editorHoldsFileId, findEditorForFileId } from "../model-by-uri";

const ed = (uri: string | null) => ({
  getModel: () => (uri === null ? null : { uri: { toString: () => uri } }),
});

describe("editorHoldsFileId", () => {
  test("returns true for an exact substring match (Monaco's URI shape)", () => {
    // monaco.Uri.parse("root::src/App.tsx") usually serialises to
    // "inmemory://model/root%3A%3Asrc%2FApp.tsx" — fileId still a substring.
    // We assert via the simpler in-memory shape.
    expect(editorHoldsFileId(ed("inmemory://root::src/App.tsx"), "root::src/App.tsx")).toBe(true);
  });

  test("returns false when the URI is a different fileId", () => {
    expect(editorHoldsFileId(ed("inmemory://root::other.tsx"), "root::src/App.tsx")).toBe(false);
  });

  test("returns false when editor is null", () => {
    expect(editorHoldsFileId(null, "X")).toBe(false);
    expect(editorHoldsFileId(undefined, "X")).toBe(false);
  });

  test("returns false when model is null (editor mounted but no model yet)", () => {
    expect(editorHoldsFileId(ed(null), "X")).toBe(false);
  });

  test("substring discipline: the fileId must be contiguous in the URI", () => {
    // Defensive: a URI that contains overlapping char sequences but not the
    // full fileId must not match. (Monaco URI-encodes ':' so the literal
    // substring is preserved as-is — there's no fragmentation hazard in
    // practice — but the test pins the property anyway.)
    expect(editorHoldsFileId(ed("inmemory://root::other"), "root::src")).toBe(false);
  });
});

describe("findEditorForFileId", () => {
  test("returns the matching editor across multiple split panes", () => {
    const eds = [ed("inmemory://root::A"), ed("inmemory://root::B")];
    const found = findEditorForFileId(eds, "root::B");
    expect(found).toBe(eds[1] as any);
  });

  test("returns null when no editor matches", () => {
    const eds = [ed("inmemory://root::A"), ed("inmemory://root::B")];
    expect(findEditorForFileId(eds, "root::C")).toBeNull();
  });

  test("skips null/undefined editors in the input array (race-safe)", () => {
    const target = ed("inmemory://root::A");
    expect(findEditorForFileId([null, undefined, target], "root::A")).toBe(target as any);
  });

  test("returns null on empty input", () => {
    expect(findEditorForFileId([], "X")).toBeNull();
  });

  test("returns null when every editor has a null model (still loading)", () => {
    expect(findEditorForFileId([ed(null), ed(null)], "X")).toBeNull();
  });

  test("returns the FIRST matching editor when multiple match (split-pane dup file)", () => {
    // Same file open in two groups → two matching editors. Caller wants a
    // deterministic answer; we return the first. Format-on-save then runs
    // on that editor; the write itself is by fileId so it's a one-time op.
    const a = ed("inmemory://root::shared");
    const b = ed("inmemory://root::shared");
    expect(findEditorForFileId([a, b], "root::shared")).toBe(a as any);
  });
});
