// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectCallCard against the real `ChatMarkdown` (web path).
 *
 * The bug this locks: the card used to render the agent-authored request and
 * reply as plain `<Text>`, so a callee reply that wrote markdown showed its
 * `**`, backticks, `- ` prefixes and dead links literally. A markdown reply
 * must come out as `<strong>`, `<code>`, `<li>`, a heading and real anchors,
 * with no raw markdown left in the visible text.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, disabled, onPress, testID, ...props },
  ref,
) {
  return React.createElement(
    "button",
    {
      ...props,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      disabled,
      onClick: disabled ? undefined : onPress,
      ref,
    },
    children as React.ReactNode,
  )
})
const TextHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function TextHost(
  { children, testID, numberOfLines: _n, selectable: _s, ...props },
  ref,
) {
  return React.createElement("span", { ...props, "data-testid": testID, ref }, children as React.ReactNode)
})
const ViewHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function ViewHost(
  { children, testID, ...props },
  ref,
) {
  return React.createElement("div", { ...props, "data-testid": testID, ref }, children as React.ReactNode)
})

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: Host,
    Text: TextHost,
    View: ViewHost,
    Linking: { openURL: async () => {}, canOpenURL: async () => false, addEventListener: () => ({ remove: () => {} }) },
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module("../../../team-chat/AgentAvatar", () => ({
  AgentAvatar: ({ name }: { name: string }) => React.createElement("i", { "data-testid": "avatar" }, name),
}))

let chatContext: any = null
mock.module("../../ChatContext", () => ({ useChatContextSafe: () => chatContext }))

const REPLY = [
  "**Done.** Ran `bun x tsc` and all four suites pass:",
  "",
  "- auth",
  "- billing",
  "",
  "## Notes",
  "",
  "```",
  "bun test",
  "```",
  "",
  "Preview: https://demo.shogo.one and [the plan](https://example.test/plan).",
].join("\n")

const REQUEST = ["**Goal:** ship the card.", "", "1. clamp the body", "2. keep the tests green"].join("\n")

const { ProjectCallCard, REPLY_MAX_HEIGHT } = await import("../ProjectCallCard")

function tool(reply = REPLY, message = REQUEST): any {
  return {
    id: "t1",
    toolName: "project_call",
    category: "other",
    state: "success",
    timestamp: 0,
    args: { project: "Worker", message, runId: "run_abcdef123456" },
    result: {
      ok: true,
      project: { id: "proj-2", name: "Worker" },
      runId: "run_abcdef123456",
      status: "completed",
      wait: true,
      chatSessionId: "9b1c2d3e-0000-5000-8000-000000000001",
      reply,
    },
  }
}

beforeEach(() => {
  chatContext = null
  document.documentElement.classList.remove("dark")
})
afterEach(cleanup)

describe("ProjectCallCard markdown rendering", () => {
  test("formats the reply: bold, inline code, list, heading, code block and links", () => {
    render(<ProjectCallCard tool={tool()} />)
    const reply = screen.getByTestId("project-call-reply")

    expect(reply.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Done.")
    expect(reply.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("bun x tsc")
    expect(reply.querySelectorAll('[data-streamdown="list-item"]').length).toBeGreaterThanOrEqual(2)
    expect(reply.querySelector('[data-streamdown="heading-2"]')?.textContent).toBe("Notes")
    expect(reply.querySelector('[data-streamdown="code-block"]')?.textContent).toContain("bun test")

    const hrefs = Array.from(reply.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("https://demo.shogo.one/")
    expect(hrefs).toContain("https://example.test/plan")
  })

  test("leaves no raw markdown in the visible reply text", () => {
    render(<ProjectCallCard tool={tool()} />)
    const text = screen.getByTestId("project-call-reply").textContent ?? ""

    expect(text).not.toContain("**")
    expect(text).not.toContain("`")
    expect(text).not.toContain("- auth")
    expect(text).not.toContain("## Notes")
    expect(text).toContain("Done.")
    expect(text).toContain("Notes")
  })

  test("formats the request the same way — callers pass multi-line briefs", () => {
    render(<ProjectCallCard tool={tool()} />)
    const request = screen.getByTestId("project-call-request")

    expect(request.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Goal:")
    expect(request.querySelectorAll('[data-streamdown="list-item"]').length).toBeGreaterThanOrEqual(2)
    expect(request.textContent).not.toContain("**")
    expect(request.textContent).toContain("clamp the body")
  })

  test("keeps the card type scale on web instead of the phone chat body size", () => {
    render(<ProjectCallCard tool={tool()} />)
    const surface = screen.getByTestId("project-call-reply").querySelector(".chat-md")

    expect(surface).toBeTruthy()
    expect(surface!.className).toContain("chat-md-compact")
    expect(surface!.className).not.toContain("chat-md-mobile")
  })

  test("opens a workspace file mentioned in the reply through openFile", () => {
    const openFile = mock((_path: string) => {})
    chatContext = { openFile, fileExists: (path: string) => path === "apps/mobile/lib/foo.ts" }
    render(<ProjectCallCard tool={tool("Edited apps/mobile/lib/foo.ts and pushed.", "go")} />)

    fireEvent.click(screen.getByTestId("chat-file-chip"))
    expect(openFile).toHaveBeenCalledWith("apps/mobile/lib/foo.ts")
  })

  test("still collapses a long reply by height and expands it", () => {
    render(<ProjectCallCard tool={tool()} />)
    const reply = screen.getByTestId("project-call-reply")
    const clamp = screen.getByTestId("project-call-reply-clamp")

    expect(clamp.style.maxHeight).toBe(`${REPLY_MAX_HEIGHT}px`)
    expect(clamp.style.overflow).toBe("hidden")

    fireEvent.click(within(reply).getByText("Show more"))

    expect(screen.getByTestId("project-call-reply-clamp").style.maxHeight).toBe("")
    expect(within(reply).getByText("Show less")).toBeTruthy()
  })
})
