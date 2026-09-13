// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      ...props
    }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          onClick: onPress,
          role: accessibilityRole,
        },
        children,
      ),
  }),
);

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

mock.module(
  resolve(import.meta.dir, "../../../phone/NativePhoneSheet"),
  () => ({
    NativePhoneSheet: ({
      visible,
      title,
      subtitle,
      children,
    }: {
      visible: boolean;
      title?: string;
      subtitle?: string;
      children: ReactNode;
    }) =>
      visible ? (
        <div data-testid="sheet">
          <h1>{title}</h1>
          {subtitle ? <span>{subtitle}</span> : null}
          {children}
        </div>
      ) : null,
  }),
);

const { NativeProjectActionsSheet } =
  await import("../NativeProjectActionsSheet");

describe("NativeProjectActionsSheet", () => {
  test("exposes the project actions and closes before running an action", () => {
    const onClose = mock(() => {});
    const onTogglePin = mock(() => {});

    render(
      <NativeProjectActionsSheet
        visible
        projectName="Website redesign"
        isPinned={false}
        onClose={onClose}
        onRename={mock(() => {})}
        onTogglePin={onTogglePin}
        onDelete={mock(() => {})}
      />,
    );

    expect(screen.getByText("Project actions")).toBeTruthy();
    expect(screen.queryByText("Website redesign")).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pin project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pin project" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  test("changes the action label when the project is already pinned", () => {
    render(
      <NativeProjectActionsSheet
        visible
        projectName="Pinned project"
        isPinned
        onClose={mock(() => {})}
        onRename={mock(() => {})}
        onTogglePin={mock(() => {})}
        onDelete={mock(() => {})}
      />,
    );

    expect(screen.getByRole("button", { name: "Unpin project" })).toBeTruthy();
  });
});
