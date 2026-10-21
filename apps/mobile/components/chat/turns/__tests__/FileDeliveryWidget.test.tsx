// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, mock, test } from "bun:test";
import React from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";
import type { ToolCallData } from "../../tools/types";

mock.module("react-native", () => createReactNativeMock());
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
const Icon = () => null;
mock.module("lucide-react-native", () => ({
  Check: Icon,
  Copy: Icon,
  Download: Icon,
  // Reached through the in-app file viewer the widget opens on web (SHO-80).
  RotateCcw: Icon,
  X: Icon,
}));
mock.module("../../FileTypeIcon", () => ({ FileTypeIcon: Icon }));

const { render, screen } = await import("@testing-library/react");
const { FileDeliveryWidget } = await import("../FileDeliveryWidget");

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
