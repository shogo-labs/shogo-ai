// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { toTerminalPtyWsUrl } from "../pty-client";

describe("pty-client", () => {
  test("builds project-scoped websocket URLs", () => {
    expect(toTerminalPtyWsUrl("https://studio.example.com", "project 1")).toBe(
      "wss://studio.example.com/api/projects/project%201/terminal/pty",
    );
    expect(toTerminalPtyWsUrl("http://localhost:8002", "abc")).toBe(
      "ws://localhost:8002/api/projects/abc/terminal/pty",
    );
  });
});
