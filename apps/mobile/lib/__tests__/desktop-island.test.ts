import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  getDesktopIslandSnapshot,
  registerDesktopIslandSession,
} from "../desktop-island"

type Action = (value: any) => void

let actionHandler: Action | null = null

function installBridge() {
  ;(globalThis as any).window = {
    shogoDesktop: {
      islandUpdate: () => {},
      onIslandAction: (handler: Action) => {
        actionHandler = handler
      },
    },
  }
}

beforeAll(() => {
  installBridge()
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

    await new Promise((resolve) => setTimeout(resolve, 75))
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
    await actionHandler?.({
      type: "send",
      target: { kind: "session", projectId: "project-2", sessionId: "session-2" },
      text: "Continue",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages).toEqual([{ text: "Continue", files: undefined }])
    dispose()
  })

  test("holds a message until a session registers", async () => {
    await actionHandler?.({
      type: "send",
      target: { kind: "session", projectId: "project-3", sessionId: "session-3" },
      text: "Start here",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

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
})
