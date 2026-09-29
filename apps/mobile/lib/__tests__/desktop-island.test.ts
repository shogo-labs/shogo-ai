// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  getDesktopIslandSnapshot,
  registerDesktopIslandSession,
  setDesktopIslandNavigator,
  updateDesktopIslandSession,
  type DesktopIslandAction,
  type DesktopIslandNavigation,
} from "../desktop-island"

let actionHandler: ((action: DesktopIslandAction) => void) | null = null

const flushPublish = () => new Promise((resolve) => setTimeout(resolve, 75))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(() => {
  ;(globalThis as any).window = {
    shogoDesktop: {
      islandUpdate: () => {},
      onIslandAction: (handler: (action: DesktopIslandAction) => void) => {
        actionHandler = handler
      },
    },
  }
})

afterEach(() => {
  setDesktopIslandNavigator(null)
})

afterAll(() => {
  delete (globalThis as any).window
})

describe("desktop island session routing", () => {
  test("publishes registered sessions with activity metadata", async () => {
    const dispose = registerDesktopIslandSession({
      sessionId: "session-1",
      projectId: "project-1",
      projectName: "Demo",
      title: "Build the feature",
      status: "running",
      sendMessage: () => {},
    })

    await flushPublish()
    expect(getDesktopIslandSnapshot().sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "Demo",
        title: "Build the feature",
        status: "running",
      }),
    ])
    dispose()
    await flushPublish()
  })

  test("sends directly to a registered session", async () => {
    const messages: Array<{ text: string; files?: unknown[] }> = []
    const dispose = registerDesktopIslandSession({
      sessionId: "session-2",
      projectId: "project-2",
      sendMessage: (text, files) => {
        messages.push({ text, files })
      },
    })

    expect(actionHandler).toBeTypeOf("function")
    actionHandler?.({
      type: "send",
      target: { kind: "session", projectId: "project-2", sessionId: "session-2" },
      text: "Continue",
    })
    await tick()
    expect(messages).toEqual([{ text: "Continue", files: undefined }])
    dispose()
  })

  test("navigates to an unmounted project and delivers once the session registers", async () => {
    const navigations: DesktopIslandNavigation[] = []
    setDesktopIslandNavigator((navigation) => navigations.push(navigation))

    actionHandler?.({
      type: "send",
      target: { kind: "session", projectId: "project-3", sessionId: "session-3" },
      text: "Start here",
    })
    await tick()
    expect(navigations).toEqual([{ projectId: "project-3", sessionId: "session-3" }])

    const messages: string[] = []
    const dispose = registerDesktopIslandSession({
      sessionId: "session-3",
      projectId: "project-3",
      sendMessage: (text) => {
        messages.push(text)
      },
    })
    expect(messages).toEqual(["Start here"])
    dispose()
  })

  test("reports a notice instead of queueing when it can't open the project", async () => {
    actionHandler?.({
      type: "send",
      target: { kind: "new", projectId: "project-4" },
      text: "Hello",
    })
    await flushPublish()
    expect(getDesktopIslandSnapshot().notice).toContain("Couldn't open")
  })

  test("keeps a permission request's start time stable across updates", async () => {
    const pending = {
      kind: "permission" as const,
      request: {
        id: "perm-1",
        toolName: "exec",
        category: "shell",
        params: {},
        reason: "Run tests",
        timeout: 30,
      },
    }
    const dispose = registerDesktopIslandSession({
      sessionId: "session-5",
      projectId: "project-5",
      pending,
      sendMessage: () => {},
    })
    await flushPublish()
    const first = getDesktopIslandSnapshot().sessions[0].pending
    expect(first?.kind).toBe("permission")

    updateDesktopIslandSession("project-5", "session-5", {
      projectName: "Project",
      title: "Chat",
      status: "running",
      pending,
    })
    await flushPublish()
    const second = getDesktopIslandSnapshot().sessions[0]
    expect(second.status).toBe("needs_approval")
    expect(second.pending).toEqual(first)
    dispose()
  })
})
