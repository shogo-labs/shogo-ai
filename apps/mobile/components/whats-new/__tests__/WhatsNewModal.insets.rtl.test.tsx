// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Locks the announcement banner's inner insets.
 *
 * The header packs its text with `justifyContent: "flex-end"`, so the space
 * above the eyebrow is leftover space — not a declared inset. A longer intro
 * grows the banner upward until that space reaches zero, which is what 2.3's
 * five-line intro did: the eyebrow sat flush against the rounded top edge
 * while the sides kept their 24px gutter.
 *
 * These assertions pin the invariant rather than a magic number: whatever the
 * values are, the top inset must be declared and must not be the shallowest of
 * the three, because it is the one that can silently collapse to zero.
 *
 * `@legendapp/motion` and `expo-linear-gradient` are inert passthroughs, and
 * the RN hosts drop `style` (React DOM cannot consume RN style arrays) — the
 * header's own style object is captured instead, which is the contract this
 * file is about.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { createReactNativeMock } from "../../../test/react-native-mock";
import type { WhatsNewRelease } from "../../../lib/whats-new/use-whats-new";

const headerStyles: Record<string, unknown>[] = [];

const host =
  (tag: "div" | "span" | "button" | "input") =>
  React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
    {
      children,
      testID,
      accessibilityLabel,
      onPress,
      // Dropped on purpose: React DOM cannot consume RN style arrays (it walks
      // their indices as property names and throws on the read-only indexed
      // properties of CSSStyleDeclaration).
      style: _style,
      // RN props with no DOM equivalent — harmless, but noisy if left in.
      accessibilityRole: _accessibilityRole,
      contentContainerStyle: _contentContainerStyle,
      showsVerticalScrollIndicator: _showsVerticalScrollIndicator,
      transparent: _transparent,
      visible: _visible,
      animationType: _animationType,
      onRequestClose: _onRequestClose,
      statusBarTranslucent: _statusBarTranslucent,
      ...props
    },
    ref,
  ) {
    return React.createElement(
      tag,
      {
        ...props,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onClick: onPress,
        ref,
      },
      children as React.ReactNode,
    );
  });

const Host = host("div");

mock.module("react-native", () =>
  createReactNativeMock({
    View: Host,
    ScrollView: Host,
    Modal: Host,
    Text: host("span"),
    Pressable: host("button"),
  }),
);

mock.module("@legendapp/motion", () => ({
  Motion: { View: Host },
}));

mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

mock.module("expo-linear-gradient", () => ({
  LinearGradient: ({
    children,
    style,
    testID,
  }: {
    children?: React.ReactNode;
    style?: Record<string, unknown>;
    testID?: string;
  }) => {
    headerStyles.push(style ?? {});
    return <div data-testid={testID}>{children}</div>;
  },
}));

const { WhatsNewModal } = await import("../WhatsNewModal");

const release: WhatsNewRelease = {
  version: "2.3",
  slug: "2-3",
  date: "2026-10-14",
  announce: true,
  title: "Shogo 2.3",
  intro:
    "In 2.3, your agents take on bigger jobs. They plan the work on a board in " +
    "your channel, keep going while it runs, and report back when it's done. " +
    "Your team gets huddles, voice notes, and roles to control who can do what.",
  url: "https://shogo.ai/changelog",
  highlights: [
    { title: "Work boards your agents run", description: "Agents set up a board." },
  ],
};

function renderModal() {
  render(
    <WhatsNewModal release={release} visible onDismiss={() => {}} />,
  );
  const style = headerStyles[0];
  expect(style).toBeDefined();
  return style;
}

const inset = (style: Record<string, unknown>, key: string) =>
  typeof style[key] === "number" ? (style[key] as number) : Number.NaN;

beforeEach(() => {
  headerStyles.length = 0;
});

describe("What's New banner insets", () => {
  test("declares a top inset instead of leaving it to flex-end leftover space", () => {
    const style = renderModal();
    const top = inset(style, "paddingTop");
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThan(0);
  });

  test("the top inset is not the shallowest of the three", () => {
    const style = renderModal();
    const top = inset(style, "paddingTop");
    const bottom = inset(style, "paddingBottom");
    const side = inset(style, "paddingHorizontal");

    expect(top).toBeGreaterThanOrEqual(bottom);
    expect(top).toBeGreaterThanOrEqual(side);
  });

  test("the banner still renders its eyebrow, title and intro", () => {
    renderModal();

    expect(screen.getByText("What's new")).toBeTruthy();
    expect(screen.getByText("Shogo 2.3")).toBeTruthy();
    expect(screen.getByText(release.intro)).toBeTruthy();
  });
});
