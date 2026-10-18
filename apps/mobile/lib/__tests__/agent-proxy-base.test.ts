// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { agentProxyBase } from "../agent-proxy-base";

describe("agentProxyBase", () => {
  test("prefers an explicit local runtime", () => {
    expect(
      agentProxyBase({
        localAgentUrl: "http://127.0.0.1:4310/",
        projectId: "proj_1",
        workspaceId: "ws_1",
        apiUrl: "https://shogo.example",
      }),
    ).toBe("http://127.0.0.1:4310");
  });

  test("a project chat goes through the project agent-proxy", () => {
    expect(
      agentProxyBase({
        projectId: "proj_1",
        apiUrl: "https://shogo.example/",
      }),
    ).toBe("https://shogo.example/api/projects/proj_1/agent-proxy");
  });

  test("a workspace chat (no project) goes through the workspace agent-proxy", () => {
    expect(
      agentProxyBase({
        workspaceId: "ws_1",
        apiUrl: "https://shogo.example",
      }),
    ).toBe("https://shogo.example/api/workspaces/ws_1/agent-proxy");
  });

  test("a project wins over a workspace when both are set", () => {
    expect(
      agentProxyBase({
        projectId: "proj_1",
        workspaceId: "ws_1",
        apiUrl: "https://shogo.example",
      }),
    ).toBe("https://shogo.example/api/projects/proj_1/agent-proxy");
  });

  test("no runtime to talk to", () => {
    expect(agentProxyBase({ apiUrl: "https://shogo.example" })).toBeNull();
  });
});
