/**
 * BUG-011 — EditorTabs RTL integration tests.
 *
 * The hook contract is covered exhaustively in useDragCancel.test.tsx.
 * These tests pin the user-visible regression: after Esc / blur /
 * visibility during a drag, the blue drop-indicator div must be GONE
 * from the DOM.
 *
 * The indicator is rendered as a 2px-wide span gated by `dropTarget`
 * state. Its presence/absence is the user-visible proxy for "drag
 * state cleared".
 */
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { EditorTabs } from "../EditorTabs";
import type { OpenFile } from "../types";

function file(id: string, name: string, extra: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    name,
    path: `/${name}`,
    language: "typescript",
    pinned: false,
    dirty: false,
    ...extra,
  } as OpenFile;
}

const FILES: OpenFile[] = [
  file("f1", "alpha.ts"),
  file("f2", "beta.ts"),
  file("f3", "gamma.ts"),
];

/** Count the blue drop-indicator spans (Tailwind `w-[2px]`) in the DOM. */
function countDropIndicators(container: HTMLElement): number {
  return container.querySelectorAll("span.w-\\[2px\\]").length;
}

/** Render and start a drag from `fromIdx` over `overIdx` (0-based). */
function startDragOver(fromIdx: number, overIdx: number) {
  const result = render(
    <EditorTabs
      files={FILES}
      activeId="f1"
      onSelect={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
    />,
  );
  const tabs = result.container.querySelectorAll('[draggable="true"]');
  const fromTab = tabs[fromIdx] as HTMLElement;
  const overTab = tabs[overIdx] as HTMLElement;
  fireEvent.dragStart(fromTab, {
    dataTransfer: { setData: () => {}, effectAllowed: "" },
  });
  Object.defineProperty(overTab, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 100,
      top: 0,
      bottom: 24,
      width: 100,
      height: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  fireEvent.dragOver(overTab, {
    clientX: 75,
    clientY: 12,
    dataTransfer: { dropEffect: "" },
  });
  return result;
}

describe("EditorTabs — BUG-011 drag cancel via Escape/blur/visibility", () => {
  test("baseline: drag-over a different tab shows a drop indicator span", () => {
    const { container } = startDragOver(0, 1);
    expect(countDropIndicators(container)).toBeGreaterThan(0);
  });

  test("Escape during drag removes the drop indicator (the regression)", () => {
    const { container } = startDragOver(0, 1);
    expect(countDropIndicators(container)).toBeGreaterThan(0);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(countDropIndicators(container)).toBe(0);
  });

  test("window blur during drag also removes the indicator (Electron focus-leave path)", () => {
    const { container } = startDragOver(0, 2);
    expect(countDropIndicators(container)).toBeGreaterThan(0);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(countDropIndicators(container)).toBe(0);
  });

  test("tab visibility hidden during drag also removes the indicator", () => {
    const { container } = startDragOver(0, 1);
    expect(countDropIndicators(container)).toBeGreaterThan(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(countDropIndicators(container)).toBe(0);
  });

  test("Escape BEFORE any drag is a no-op (listener only attaches during drag)", () => {
    const { container } = render(
      <EditorTabs
        files={FILES}
        activeId="f1"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(countDropIndicators(container)).toBe(0);
    expect(() => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    }).not.toThrow();
    expect(countDropIndicators(container)).toBe(0);
    expect(container.querySelectorAll('[draggable="true"]').length).toBe(3);
  });
});
