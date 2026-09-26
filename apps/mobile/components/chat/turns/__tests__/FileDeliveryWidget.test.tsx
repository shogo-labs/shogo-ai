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
}));

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

test("renders the direct download URL and delivery actions", () => {
  render(<FileDeliveryWidget tool={tool} />);

  expect(screen.getByText("report.pdf")).toBeTruthy();
  expect(screen.getByText("https://api.example/f/signed-token")).toBeTruthy();
  expect(screen.getByText("Download")).toBeTruthy();
  expect(screen.getByText("Copy link")).toBeTruthy();
});
