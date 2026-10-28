// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { agentProxyBase, projectAgentProxyBase } from "../agent-proxy-base";

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

  test("a machine workspace goes through that machine's relay with its own id", () => {
    expect(
      agentProxyBase({
        workspaceId: "ws-cloud",
        machine: { instanceId: "inst-1", localWorkspaceId: "lw-1" },
        apiUrl: "https://shogo.example",
      }),
    ).toBe(
      "https://shogo.example/api/machines/inst-1/w/lw-1/api/workspaces/lw-1/agent-proxy",
    );
  });

  test("the machine loses to an explicit local runtime and to a project", () => {
    expect(
      agentProxyBase({
        localAgentUrl: "http://127.0.0.1:4310",
        machine: { instanceId: "inst-1", localWorkspaceId: "lw-1" },
        apiUrl: "https://shogo.example",
      }),
    ).toBe("http://127.0.0.1:4310");
    expect(
      agentProxyBase({
        projectId: "proj_1",
        machine: { instanceId: "inst-1", localWorkspaceId: "lw-1" },
        apiUrl: "https://shogo.example",
      }),
    ).toBe("https://shogo.example/api/projects/proj_1/agent-proxy");
  });

  test("without a machine nothing changes", () => {
    expect(
      agentProxyBase({ workspaceId: "ws_1", machine: null, apiUrl: "https://shogo.example" }),
    ).toBe("https://shogo.example/api/workspaces/ws_1/agent-proxy");
  });

  test("no runtime to talk to", () => {
    expect(agentProxyBase({ apiUrl: "https://shogo.example" })).toBeNull();
  });
});

describe("projectAgentProxyBase", () => {
  test("reaches another project of the workspace", () => {
    expect(
      projectAgentProxyBase({ projectId: "proj_1", apiUrl: "https://shogo.example/" }),
    ).toBe("https://shogo.example/api/projects/proj_1/agent-proxy");
  });

  test("a machine's workspace reaches the project on that machine", () => {
    expect(
      projectAgentProxyBase({
        projectId: "proj_1",
        relayBase: "https://shogo.example/api/machines/inst-1/w/lw-1",
        apiUrl: "https://shogo.example",
      }),
    ).toBe("https://shogo.example/api/machines/inst-1/w/lw-1/api/projects/proj_1/agent-proxy");
  });

  test("no project, or no origin, means no URL", () => {
    expect(projectAgentProxyBase({ projectId: null, apiUrl: "https://shogo.example" })).toBeNull();
    expect(projectAgentProxyBase({ projectId: "  ", apiUrl: "https://shogo.example" })).toBeNull();
    expect(projectAgentProxyBase({ projectId: "proj_1", apiUrl: "" })).toBeNull();
  });
});
