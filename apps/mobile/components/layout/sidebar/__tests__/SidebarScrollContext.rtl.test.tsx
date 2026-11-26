// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";

const {
  SidebarScrollProvider,
  createSidebarScrollSignal,
  isSidebarScrollEnd,
  useSidebarScrollEnd,
  SIDEBAR_SCROLL_END_THRESHOLD,
} = await import("../SidebarScrollContext");

beforeEach(() => {
  cleanup();
});

/** A leaf that consumes the panel's scroll signal and reports what it saw. */
function Probe({
  onScrollEnd,
  enabled,
}: {
  onScrollEnd: () => void;
  enabled?: boolean;
}) {
  const available = useSidebarScrollEnd(onScrollEnd, enabled);
  return <span data-testid="probe" data-has-signal={String(available)} />;
}

const metrics = (
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
) => ({ offsetY, contentHeight, viewportHeight });

describe("isSidebarScrollEnd", () => {
  test("a panel scrolled to within the threshold of the bottom is at its end", () => {
    const viewport = 800;
    const content = 3000;
    const bottom = content - viewport;

    expect(isSidebarScrollEnd(metrics(bottom - 300, content, viewport))).toBe(false);
    expect(
      isSidebarScrollEnd(metrics(bottom - SIDEBAR_SCROLL_END_THRESHOLD, content, viewport)),
    ).toBe(true);
    expect(isSidebarScrollEnd(metrics(bottom, content, viewport))).toBe(true);
  });

  test("content shorter than the viewport counts as its end, so a tall window fills itself", () => {
    // AC3: no scroll is possible yet, so the list has to grow on its own.
    expect(isSidebarScrollEnd(metrics(0, 300, 800))).toBe(true);
    expect(isSidebarScrollEnd(metrics(0, 2000, 800))).toBe(false);
  });
});

describe("useSidebarScrollEnd", () => {
  test("reports that no scroll view is providing the signal, and never fires one", () => {
    const onScrollEnd = mock(() => {});
    render(<Probe onScrollEnd={onScrollEnd} />);

    expect(screen.getByTestId("probe").getAttribute("data-has-signal")).toBe("false");
    expect(onScrollEnd).not.toHaveBeenCalled();
  });

  test("fires the listener on each scroll-end while it is subscribed", () => {
    const signal = createSidebarScrollSignal();
    const onScrollEnd = mock(() => {});
    const view = render(
      <SidebarScrollProvider signal={signal}>
        <Probe onScrollEnd={onScrollEnd} />
      </SidebarScrollProvider>,
    );

    expect(screen.getByTestId("probe").getAttribute("data-has-signal")).toBe("true");

    signal.notify();
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    view.unmount();
    signal.notify();
    expect(onScrollEnd).toHaveBeenCalledTimes(1);
  });

  test("a disabled listener stays silent", () => {
    const signal = createSidebarScrollSignal();
    const onScrollEnd = mock(() => {});
    render(
      <SidebarScrollProvider signal={signal}>
        <Probe onScrollEnd={onScrollEnd} enabled={false} />
      </SidebarScrollProvider>,
    );

    signal.notify();
    expect(onScrollEnd).not.toHaveBeenCalled();
  });

  /**
   * SHO-579: the listener the signal fires must be the one from the render on
   * screen, from the moment that render commits. A native scroll event lands
   * between the commit and React's passive-effect flush, so a listener wired in
   * a `useEffect` is one render behind when it matters — for the chat list that
   * is the empty list it mounted with, so the grow is capped at zero.
   */
  test("a scroll-end dispatched during a commit runs that render's listener, not the previous one", () => {
    const signal = createSidebarScrollSignal();
    // Each render's listener closes over the row count that render drew, the
    // way WorkspaceChatsPanel's closes over `visibleCount`.
    const ran: number[] = [];

    function List({ drawn }: { drawn: number }) {
      useSidebarScrollEnd(() => ran.push(drawn));
      return null;
    }

    // Notifies from a layout effect: after List's own layout effects in the
    // same commit, and before any passive effect can run.
    function ScrollEndInCommit({ tick }: { tick: number }) {
      useLayoutEffect(() => {
        if (tick > 0) signal.notify();
      }, [tick]);
      return null;
    }

    const tree = (drawn: number, tick: number) => (
      <SidebarScrollProvider signal={signal}>
        <List drawn={drawn} />
        <ScrollEndInCommit tick={tick} />
      </SidebarScrollProvider>
    );

    const view = render(tree(30, 0));
    ran.length = 0;

    view.rerender(tree(60, 1));

    expect(ran).toEqual([60]);
  });
});
