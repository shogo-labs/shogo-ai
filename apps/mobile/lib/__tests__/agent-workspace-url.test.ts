// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { buildAgentWorkspaceUrl } from "../agent-workspace-url";

describe("buildAgentWorkspaceUrl", () => {
  test("encodes each workspace path segment without encoding separators", () => {
    expect(
      buildAgentWorkspaceUrl(
        "https://agent.example/api/",
        "images/My generated image #1.png",
      ),
    ).toBe(
      "https://agent.example/api/agent/workspace/download/images/My%20generated%20image%20%231.png",
    );
  });

  test("normalizes empty path separators", () => {
    expect(
      buildAgentWorkspaceUrl("https://agent.example", "/images/a.png/"),
    ).toBe("https://agent.example/agent/workspace/download/images/a.png");
  });
});
