// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test";
import { autoNameSession, isPlaceholderSessionName } from "../auto-name-session";

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

  test("treats default chat names as placeholders", () => {
    for (const name of ["", null, undefined, "Untitled", "Untitled chat", " New chat ", "workspace chat"]) {
      expect(isPlaceholderSessionName(name)).toBe(true);
    }
    for (const name of ["Chat", "Debug with AI", "Launch checklist"]) {
      expect(isPlaceholderSessionName(name)).toBe(false);
    }
  });

  test("renames sessions with default placeholder names", async () => {
    for (const placeholder of ["New chat", "Untitled chat", "Workspace chat"]) {
      const updateSession = mock(async () => {});
      await autoNameSession({
        sessionId: "session-1",
        userText: "Plan a trip",
        projectId: "project-1",
        getSession: () => ({ inferredName: placeholder, name: "" }),
        getProjectName: () => "Existing project",
        generateName: async () => ({ name: "Trip Plan", source: "ai" }),
        updateProject: mock(async () => {}),
        updateSession,
        emitRefresh: mock(() => {}),
      });
      expect(updateSession).toHaveBeenCalledWith("session-1", { inferredName: "Trip Plan" });
    }
  });

  test("does not rename sessions that already have a real name", async () => {
    const generateName = mock(async () => ({ name: "Nope", source: "ai" }));
    const updateSession = mock(async () => {});
    for (const real of ["Chat", "Debug with AI"]) {
      await autoNameSession({
        sessionId: "session-1",
        userText: "Hello",
        getSession: () => ({ inferredName: real }),
        getProjectName: () => null,
        generateName,
        updateProject: mock(async () => {}),
        updateSession,
        emitRefresh: mock(() => {}),
      });
    }
    expect(generateName).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("loads a server-side session before persisting the name", async () => {
    let loaded = false;
    const loadSession = mock(async () => {
      loaded = true;
    });
    const updateSession = mock(async () => {});
    await autoNameSession({
      sessionId: "ws-session",
      userText: "Plan a trip",
      workspaceId: "workspace-1",
      getSession: () => (loaded ? { inferredName: "New chat" } : undefined),
      loadSession,
      getProjectName: () => null,
      generateName: async () => ({ name: "Trip Plan", source: "ai" }),
      updateProject: mock(async () => {}),
      updateSession,
      emitRefresh: mock(() => {}),
    });
    expect(loadSession).toHaveBeenCalledWith("ws-session");
    expect(updateSession).toHaveBeenCalledWith("ws-session", { inferredName: "Trip Plan" });
  });

  test("does not persist when the session is still missing after loading", async () => {
    const updateSession = mock(async () => {});
    await autoNameSession({
      sessionId: "gone",
      userText: "Plan a trip",
      getSession: () => undefined,
      loadSession: async () => {
        throw new Error("not found");
      },
      getProjectName: () => null,
      generateName: async () => ({ name: "Trip Plan", source: "ai" }),
      updateProject: mock(async () => {}),
      updateSession,
      emitRefresh: mock(() => {}),
    });
    expect(updateSession).not.toHaveBeenCalled();
  });
});
