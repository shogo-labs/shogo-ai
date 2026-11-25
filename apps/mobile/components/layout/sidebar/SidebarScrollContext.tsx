// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One "the sidebar panel is near its end" signal, owned by the panel's scroll
 * view and shared by any list inside it that grows as you scroll.
 *
 * Every wide tab panel is drawn inside the same `ScrollView` (AppSidebar's
 * `renderSidebar`), so a list that wants to page on scroll cannot watch its own
 * scroll view — it has to hear about that one. `SidebarScrollView` provides the
 * signal, `useSidebarScrollEnd` consumes it, and with no provider the hook
 * reports `false` so a list renders everything: rows must never sit behind a
 * trigger that can't fire.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { ScrollView, type ScrollViewProps } from "react-native";

/** How close to the bottom (px) counts as "near the end". */
export const SIDEBAR_SCROLL_END_THRESHOLD = 200;

type ScrollEndListener = () => void;

export interface SidebarScrollMetrics {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}

export interface SidebarScrollSignal {
  subscribe: (listener: ScrollEndListener) => () => void;
  /** Tell every subscriber the panel is near its end. */
  notify: () => void;
}

/**
 * Near the end, or not yet tall enough to scroll at all. The second case is
 * what fills a tall window without the user having to scroll for it.
 */
export function isSidebarScrollEnd({
  offsetY,
  contentHeight,
  viewportHeight,
}: SidebarScrollMetrics): boolean {
  return (
    contentHeight - (offsetY + viewportHeight) <= SIDEBAR_SCROLL_END_THRESHOLD
  );
}

export function createSidebarScrollSignal(): SidebarScrollSignal {
  const listeners = new Set<ScrollEndListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

export const SidebarScrollContext = createContext<SidebarScrollSignal | null>(
  null,
);

export function SidebarScrollProvider({
  signal,
  children,
}: {
  signal: SidebarScrollSignal;
  children: ReactNode;
}) {
  return (
    <SidebarScrollContext.Provider value={signal}>
      {children}
    </SidebarScrollContext.Provider>
  );
}

/**
 * The panel's scroll view. Fires the signal when the content is within
 * `SIDEBAR_SCROLL_END_THRESHOLD` of the bottom, and while the content is
 * shorter than the viewport, so a list can fill the window it is drawn in.
 * Growth renders more rows, which changes the content size and measures again;
 * a subscriber with nothing left to add leaves the size alone and the loop
 * stops there.
 */
export function SidebarScrollView({
  children,
  onScroll,
  onContentSizeChange,
  onLayout,
  ...props
}: ScrollViewProps) {
  const signal = useMemo(createSidebarScrollSignal, []);
  const metrics = useRef<SidebarScrollMetrics>({
    offsetY: 0,
    contentHeight: 0,
    viewportHeight: 0,
  });

  const measure = useCallback(() => {
    if (isSidebarScrollEnd(metrics.current)) signal.notify();
  }, [signal]);

  return (
    <SidebarScrollContext.Provider value={signal}>
      <ScrollView
        {...props}
        onScroll={(event) => {
          metrics.current.offsetY = event.nativeEvent.contentOffset.y;
          onScroll?.(event);
          measure();
        }}
        scrollEventThrottle={64}
        onContentSizeChange={(width, height) => {
          metrics.current.contentHeight = height;
          onContentSizeChange?.(width, height);
          measure();
        }}
        onLayout={(event) => {
          metrics.current.viewportHeight = event.nativeEvent.layout.height;
          onLayout?.(event);
          measure();
        }}
      >
        {children}
      </ScrollView>
    </SidebarScrollContext.Provider>
  );
}

/**
 * Runs `listener` each time the panel nears its end. Returns whether a scroll
 * view is providing the signal at all.
 */
export function useSidebarScrollEnd(
  listener: ScrollEndListener,
  enabled = true,
): boolean {
  const signal = useContext(SidebarScrollContext);
  const latest = useRef(listener);
  // A layout effect, not a passive one: it runs in the same task as the commit
  // that drew the rows, so no scroll-end can be dispatched in between. With an
  // effect there is a window after every render where the subscription still
  // points at the previous render's listener — for the chat list that is the
  // empty list it mounted with, so the grow is capped at zero and the signal is
  // dropped (SHO-579: 30 rows drawn, a scroll-end delivered, nothing grown).
  useLayoutEffect(() => {
    latest.current = listener;
  }, [listener]);
  useEffect(() => {
    if (!signal || !enabled) return;
    return signal.subscribe(() => latest.current());
  }, [signal, enabled]);
  return signal !== null;
}
