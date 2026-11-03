// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, mock, test } from "bun:test";
import React from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";
import * as lucideStub from "../../../../test/stubs/lucide-react-native";
import type { ToolCallData } from "../../tools/types";

mock.module("react-native", () =>
  createReactNativeMock({
    // The chip is a Pressable; the passthrough mock drops `onPress`, so wire it
    // to a real DOM click to prove a local share opens the in-app viewer.
    Pressable: ({ children, onPress, disabled, testID, ...rest }: Record<string, unknown>) =>
      React.createElement(
        "button",
        {
          ...rest,
          "data-rn-shim": testID as string,
          disabled: !!disabled,
          onClick: disabled ? undefined : (onPress as () => void),
        },
        children as React.ReactNode,
      ),
  } as never),
);
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
const Icon = () => null;
// The shared stub, not a hand-picked subset: the viewer the widget opens on
// web now renders through the app's one file body, which draws the IDE's
// media previews too (SHO-165).
mock.module("lucide-react-native", () => lucideStub);
mock.module("../../FileTypeIcon", () => ({ FileTypeIcon: Icon }));

const { fireEvent, render, screen } = await import("@testing-library/react");
const { FileDeliveryWidget } = await import("../FileDeliveryWidget");
const { ShareFileProvider } = await import("../../share-file-context");

const tool = {
  id: "share-1",
  toolName: "share_file",
  category: "other",
  state: "success",
  args: { path: "report.pdf" },
  result: {
    ok: true,
    url: "https://api.example/f/signed-token",
    filename: "report.pdf",
    path: "report.pdf",
    expiresAt: "2026-10-03T00:00:00.000Z",
  },
  timestamp: 0,
} as ToolCallData;

test("renders a download chip with a copy-link action", () => {
  render(<FileDeliveryWidget tool={tool} />);

  expect(screen.getByText("report.pdf")).toBeTruthy();
  expect(screen.getByTitle(/^Download report\.pdf · Link expires/)).toBeTruthy();
  expect(screen.getByTitle("Copy link")).toBeTruthy();
  expect(screen.queryByText("https://api.example/f/signed-token")).toBeNull();
});

/**
 * On local desktop `share_file` returns a `file://` link to a file already on
 * this disk (SHO-302): there is no token to expire, so the chip says nothing
 * about expiry and the thing worth copying is the path.
 */
const localTool = {
  ...tool,
  result: {
    ok: true,
    local: true,
    url: "file:///Users/me/out/report.pdf",
    path: "/Users/me/out/report.pdf",
    linkPath: "out/report.pdf",
    filename: "report.pdf",
    size: 1024,
  },
} as ToolCallData;

test("a local share says nothing about expiry and copies the path", () => {
  render(<FileDeliveryWidget tool={localTool} />);

  expect(screen.getByText("report.pdf")).toBeTruthy();
  expect(screen.getByText("/Users/me/out/report.pdf")).toBeTruthy();
  expect(screen.getByTitle(/^Open report\.pdf · \/Users\/me\/out\/report\.pdf$/)).toBeTruthy();
  expect(screen.getByTitle("Copy path")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Link expires");
});

test("a local share opens the app's viewer, not the file:// URL", () => {
  const opened: Array<Record<string, unknown>> = [];
  render(
    <ShareFileProvider open={(target) => opened.push(target as Record<string, unknown>)}>
      <FileDeliveryWidget tool={localTool} />
    </ShareFileProvider>,
  );

  fireEvent.click(screen.getByText("report.pdf"));

  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({
    kind: "local",
    path: "/Users/me/out/report.pdf",
    name: "report.pdf",
  });
});
