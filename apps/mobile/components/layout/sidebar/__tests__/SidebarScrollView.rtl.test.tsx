// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-530: the sidebar's scroll view turns real scroll/layout events into the
 * one "near the end" signal the Home list grows on. The list's own tests fire
 * the signal directly, so this is where the wiring to `onScroll` /
 * `onContentSizeChange` / `onLayout` is proven.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, forwardRef } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

/** The props the component handed the scroll view, so a test can fire them. */
let scrollProps: any = null;

const MockScrollView = forwardRef(function MockScrollView(
  { children, ...props }: any,
  _ref,
) {
  scrollProps = props;
  return createElement("div", { "data-testid": "scroll-view" }, children);
});

mock.module("react-native", () =>
  createReactNativeMock({ ScrollView: MockScrollView }),
);

const { SidebarScrollView, useSidebarScrollEnd } = await import(
  "../SidebarScrollContext"
);

function Probe({ onScrollEnd }: { onScrollEnd: () => void }) {
  const available = useSidebarScrollEnd(onScrollEnd);
  return <span data-testid="probe" data-has-signal={String(available)} />;
}

const layout = (height: number) => ({ nativeEvent: { layout: { height } } });
const scrollTo = (y: number) => ({ nativeEvent: { contentOffset: { y } } });

beforeEach(() => {
  cleanup();
  scrollProps = null;
});

describe("SidebarScrollView", () => {
  test("provides the signal to the list and measures the viewport and content", () => {
    const onScrollEnd = mock(() => {});
    render(
      <SidebarScrollView>
        <Probe onScrollEnd={onScrollEnd} />
      </SidebarScrollView>,
    );

    expect(screen.getByTestId("probe").getAttribute("data-has-signal")).toBe("true");
    expect(scrollProps.scrollEventThrottle).toBe(64);

    // AC3: the panel is measured but has no content yet — it is shorter than
    // the viewport, so the list is asked to grow without any scroll.
    act(() => {
      scrollProps.onLayout(layout(800));
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    // Tall content, still at the top: not near the end.
    act(() => {
      scrollProps.onContentSizeChange(400, 3000);
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    // Halfway down: still not near the end.
    act(() => {
      scrollProps.onScroll(scrollTo(1000));
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(1);

    // Within the 200px threshold of the bottom: grow.
    act(() => {
      scrollProps.onScroll(scrollTo(2100));
    });
    expect(onScrollEnd).toHaveBeenCalledTimes(2);
  });

  test("a scroll event still reaches the caller's own onScroll", () => {
    const onScroll = mock(() => {});
    render(<SidebarScrollView onScroll={onScroll} />);

    act(() => {
      scrollProps.onScroll(scrollTo(10));
    });
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});
