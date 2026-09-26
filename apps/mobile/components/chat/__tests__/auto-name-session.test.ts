// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test";
import { autoNameSession } from "../auto-name-session";

describe("autoNameSession", () => {
  test("persists the generated name and refreshes project chat lists", async () => {
    const order: string[] = [];
    const session = { inferredName: null, name: null };
    const updateSession = mock(async () => {
      order.push("session");
    });
    const emitRefresh = mock(() => {
      order.push("refresh");
    });

    await autoNameSession({
      sessionId: "session-1",
      userText: "Build a launch checklist",
      workspaceId: "workspace-1",
      projectId: "project-1",
      getSession: () => session,
      getProjectName: () => "Existing project",
      generateName: async () => {
        order.push("generate");
        return { name: "Launch checklist", source: "ai" };
      },
      updateProject: mock(async () => {}),
      updateSession,
      emitRefresh,
    });

    expect(order).toEqual(["generate", "session", "refresh"]);
    expect(updateSession).toHaveBeenCalledWith("session-1", {
      inferredName: "Launch checklist",
    });
    expect(emitRefresh).toHaveBeenCalledWith({
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });
  });

  test("renames a new project before emitting the chat refresh", async () => {
    const order: string[] = [];

    await autoNameSession({
      sessionId: "session-1",
      userText: "Create a recipe planner",
      projectId: "project-1",
      getSession: () => ({}),
      getProjectName: () => "New Project",
      generateName: async () => ({
        name: "Recipe planner",
        description: "Plan recipes",
        source: "ai",
      }),
      updateProject: mock(async () => {
        order.push("project");
      }),
      updateSession: mock(async () => {
        order.push("session");
      }),
      emitRefresh: mock(() => {
        order.push("refresh");
      }),
    });

    expect(order).toEqual(["project", "session", "refresh"]);
  });

  test("does not persist heuristic names or names for deleted sessions", async () => {
    const updateSession = mock(async () => {});
    const generateName = mock(async () => ({
      name: "Generated",
      source: "heuristic",
    }));

    await autoNameSession({
      sessionId: "session-1",
      userText: "Do the thing",
      getSession: () => ({}),
      getProjectName: () => null,
      generateName,
      updateProject: mock(async () => {}),
      updateSession,
      emitRefresh: mock(() => {}),
    });
    expect(updateSession).not.toHaveBeenCalled();

    await autoNameSession({
      sessionId: "session-2",
      userText: "Do another thing",
      getSession: () => undefined,
      getProjectName: () => null,
      generateName: async () => ({
        name: "Should not persist",
        source: "ai",
      }),
      updateProject: mock(async () => {}),
      updateSession,
      emitRefresh: mock(() => {}),
    });
    expect(updateSession).not.toHaveBeenCalled();
  });
});
