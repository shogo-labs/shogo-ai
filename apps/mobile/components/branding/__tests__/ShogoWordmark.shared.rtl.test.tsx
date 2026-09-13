// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import * as React from "react";
import { createRequire } from "node:module";
import { createReactNativeMock } from "../../../test/react-native-mock";

const nativeMock = createReactNativeMock({
  View: ({
    children,
    className,
    accessible: _accessible,
    accessibilityElementsHidden: _accessibilityElementsHidden,
    importantForAccessibility: _importantForAccessibility,
    accessibilityLabel: _accessibilityLabel,
    ...props
  }: Record<string, unknown>) => React.createElement("div", { ...props, className }, children),
});
mock.module("react-native", () => nativeMock);
const sharedRequire = createRequire(
  new URL(
    "../../../../../packages/shared-ui/src/branding/ShogoWordmark.tsx",
    import.meta.url,
  ),
);
mock.module(sharedRequire.resolve("react-native"), () => nativeMock);

const Svg = ({
  children,
  ...props
}: React.PropsWithChildren<Record<string, unknown>>) =>
  React.createElement("svg", props, children);
const Path = (props: Record<string, unknown>) =>
  React.createElement("path", props);
const svgMock = { default: Svg, Path };
mock.module("react-native-svg", () => svgMock);
mock.module(sharedRequire.resolve("react-native-svg"), () => svgMock);

const { ShogoWordmark } = await import("@shogo/shared-ui/branding");

describe("shared ShogoWordmark", () => {
  test("renders the selected light and dark wordmark geometry", () => {
    const light = render(<ShogoWordmark colorScheme="light" />);
    expect(light.container.querySelector('[role="img"]')).toBeTruthy();
    expect(light.container.querySelector('[fill="#212121"]')).toBeTruthy();
    expect(light.container.querySelector('[fill="white"]')).toBeNull();

    light.unmount();
    const dark = render(
      <ShogoWordmark colorScheme="dark" />,
    );
    expect(dark.container.querySelector('[fill="white"]')).toBeTruthy();
    expect(dark.container.querySelector('[fill="#212121"]')).toBeNull();
  });

  test("supports caller sizing and decorative accessibility mode", () => {
    const { container } = render(
      <ShogoWordmark className="h-9 w-36" decorative />,
    );

    const root = container.querySelector("div");
    expect(root).toBeTruthy();
    expect(root).toHaveClass("h-9", "w-36");
    expect(root?.getAttribute("role")).not.toBe("img");
  });
});
