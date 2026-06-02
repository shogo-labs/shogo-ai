/**
 * BUG-011 — useDragCancel hook unit tests.
 *
 * The hook is the universal cancel-path for HTML5 drag operations.
 * These tests pin its three signals (Esc, blur, visibility) and the
 * subtle attachment/cleanup semantics that keep it from leaking
 * listeners across renders.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useDragCancel } from "../useDragCancel";

function dispatchKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ...opts }));
  });
}

function dispatchBlur() {
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
}

function dispatchVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("useDragCancel — listener attachment", () => {
  let added: Array<{ target: "window" | "document"; type: string; capture: boolean }>;
  let removed: Array<{ target: "window" | "document"; type: string; capture: boolean }>;
  let restoreWin: () => void;
  let restoreDoc: () => void;

  beforeEach(() => {
    added = [];
    removed = [];
    const origWinAdd = window.addEventListener.bind(window);
    const origWinRem = window.removeEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    const origDocRem = document.removeEventListener.bind(document);
    window.addEventListener = ((type: string, fn: any, opts: any) => {
      added.push({ target: "window", type, capture: opts === true || !!opts?.capture });
      return origWinAdd(type, fn, opts);
    }) as any;
    window.removeEventListener = ((type: string, fn: any, opts: any) => {
      removed.push({ target: "window", type, capture: opts === true || !!opts?.capture });
      return origWinRem(type, fn, opts);
    }) as any;
    document.addEventListener = ((type: string, fn: any, opts: any) => {
      added.push({ target: "document", type, capture: opts === true || !!opts?.capture });
      return origDocAdd(type, fn, opts);
    }) as any;
    document.removeEventListener = ((type: string, fn: any, opts: any) => {
      removed.push({ target: "document", type, capture: opts === true || !!opts?.capture });
      return origDocRem(type, fn, opts);
    }) as any;
    restoreWin = () => {
      window.addEventListener = origWinAdd as any;
      window.removeEventListener = origWinRem as any;
    };
    restoreDoc = () => {
      document.addEventListener = origDocAdd as any;
      document.removeEventListener = origDocRem as any;
    };
  });

  afterEach(() => {
    restoreWin();
    restoreDoc();
  });

  test("attaches no listeners when active=false", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(false, cancel));
    expect(
      added.filter(
        (a) => a.type === "keydown" || a.type === "blur" || a.type === "visibilitychange",
      ),
    ).toHaveLength(0);
  });

  test("attaches keydown / blur / visibilitychange when active=true", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    const types = added
      .map((a) => a.type)
      .filter((t) => t === "keydown" || t === "blur" || t === "visibilitychange");
    expect(types.sort()).toEqual(["blur", "keydown", "visibilitychange"]);
  });

  test("keydown is registered in CAPTURE phase (so modals can't swallow Esc first)", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    const keydown = added.find((a) => a.type === "keydown");
    expect(keydown?.capture).toBe(true);
  });

  test("removes all listeners when active flips to false", () => {
    const cancel = mock(() => {});
    const { rerender } = renderHook(({ active }) => useDragCancel(active, cancel), {
      initialProps: { active: true },
    });
    expect(
      removed.filter((a) => ["keydown", "blur", "visibilitychange"].includes(a.type)),
    ).toHaveLength(0);
    rerender({ active: false });
    const removedTypes = removed
      .map((a) => a.type)
      .filter((t) => ["keydown", "blur", "visibilitychange"].includes(t));
    expect(removedTypes.sort()).toEqual(["blur", "keydown", "visibilitychange"]);
  });

  test("removes all listeners on unmount", () => {
    const cancel = mock(() => {});
    const { unmount } = renderHook(() => useDragCancel(true, cancel));
    expect(removed).toHaveLength(0);
    unmount();
    const removedTypes = removed
      .map((a) => a.type)
      .filter((t) => ["keydown", "blur", "visibilitychange"].includes(t));
    expect(removedTypes.sort()).toEqual(["blur", "keydown", "visibilitychange"]);
  });

  test("does NOT re-attach listeners when cancel callback identity changes", () => {
    // Stable subscription: a parent that passes an inline () => {...} on
    // every render must NOT churn the window-level listener 60×/sec.
    const cancelA = mock(() => {});
    const cancelB = mock(() => {});
    const { rerender } = renderHook(({ cb }) => useDragCancel(true, cb), {
      initialProps: { cb: cancelA },
    });
    const initialKeydownCount = added.filter((a) => a.type === "keydown").length;
    rerender({ cb: cancelB });
    rerender({ cb: cancelA });
    rerender({ cb: cancelB });
    expect(added.filter((a) => a.type === "keydown")).toHaveLength(initialKeydownCount);
  });
});

describe("useDragCancel — cancel triggers", () => {
  test("Esc keydown invokes cancel", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("Esc with Shift modifier still cancels", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchKey("Escape", { shiftKey: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("Esc with Cmd/Meta modifier still cancels (matches native UX)", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchKey("Escape", { metaKey: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("non-Esc keys do NOT cancel", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchKey("Enter");
    dispatchKey("a");
    dispatchKey("Tab");
    dispatchKey("ArrowLeft");
    dispatchKey(" ");
    expect(cancel).toHaveBeenCalledTimes(0);
  });

  test("window blur invokes cancel", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchBlur();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("visibilitychange to hidden invokes cancel", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchVisibility("hidden");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("visibilitychange to visible does NOT cancel", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchVisibility("visible");
    expect(cancel).toHaveBeenCalledTimes(0);
  });

  test("multiple Esc presses each fire cancel (no internal dedupe)", () => {
    const cancel = mock(() => {});
    renderHook(() => useDragCancel(true, cancel));
    dispatchKey("Escape");
    dispatchKey("Escape");
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  test("Esc fired BEFORE active=true is ignored", () => {
    const cancel = mock(() => {});
    const { rerender } = renderHook(({ active }) => useDragCancel(active, cancel), {
      initialProps: { active: false },
    });
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(0);
    rerender({ active: true });
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("Esc fired AFTER active flips back to false is ignored", () => {
    const cancel = mock(() => {});
    const { rerender } = renderHook(({ active }) => useDragCancel(active, cancel), {
      initialProps: { active: true },
    });
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("after unmount, Esc is ignored", () => {
    const cancel = mock(() => {});
    const { unmount } = renderHook(() => useDragCancel(true, cancel));
    unmount();
    dispatchKey("Escape");
    expect(cancel).toHaveBeenCalledTimes(0);
  });

  test("uses LATEST cancel callback even though subscription is stable", () => {
    // The ref-pin pattern means we don't tear down the listener, but we
    // still need the LATEST callback to fire. This test pins that
    // invariant — without it the hook would be a memory bug magnet.
    const cancelA = mock(() => {});
    const cancelB = mock(() => {});
    const { rerender } = renderHook(({ cb }) => useDragCancel(true, cb), {
      initialProps: { cb: cancelA },
    });
    dispatchKey("Escape");
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).toHaveBeenCalledTimes(0);

    rerender({ cb: cancelB });
    dispatchKey("Escape");
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).toHaveBeenCalledTimes(1);
  });
});
