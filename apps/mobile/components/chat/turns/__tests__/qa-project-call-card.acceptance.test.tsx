// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance (SHO-100) — a `project_call` card renders its request and
 * reply as markdown.
 *
 * Runs against the real `ChatMarkdown` on the web path (the only surface a bun
 * test can render: `react-native-marked` cannot be imported here). The
 * collapsed-preview geometry is tied to the card line height that ships in
 * `global.css` / `MarkdownText`'s card styles, so a clamp that is not a whole
 * number of lines — the case where the last visible line is a chopped row of
 * glyphs — fails here rather than in a screenshot.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
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

/** Keeps `numberOfLines` visible: the clamp on plain (non-markdown) text. */
const TextHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function TextHost(
  { children, numberOfLines, selectable: _s, testID, ...props },
  ref,
) {
  return React.createElement(
    "span",
    {
      ...props,
      "data-number-of-lines": numberOfLines ?? undefined,
      "data-testid": testID,
      ref,
    },
    children as React.ReactNode,
  )
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
].join("\n")

const REQUEST = ["**Goal:** ship the card.", "", "1. clamp the body", "2. keep the tests green"].join("\n")

/** Long enough to overflow four clamped lines, the way a failed call's payload can. */
const LONG_ERROR = [
  "Project call failed with HTTP 500:",
  "",
  "```json",
  "{",
  '  "error": "internal_error",',
  '  "code": "agent_run_crashed",',
  '  "requestId": "req_9f2c1d",',
  '  "detail": "the callee stopped before it answered"',
  "}",
  "```",
].join("\n")

const { ProjectCallCard } = await import("../ProjectCallCard")

function tool(overrides: { reply?: string; message?: string; error?: string } = {}): any {
  const result: Record<string, unknown> = {
    ok: true,
    project: { id: "proj-2", name: "Worker" },
    runId: "run_abcdef123456",
    status: "completed",
    wait: true,
    chatSessionId: "9b1c2d3e-0000-5000-8000-000000000001",
  }
  if (overrides.error) {
    result.error = overrides.error
    result.hint = "The callee is still working."
  } else {
    result.reply = overrides.reply ?? REPLY
  }
  return {
    id: "t1",
    toolName: "project_call",
    category: "other",
    state: overrides.error ? "error" : "success",
    timestamp: 0,
    args: { project: "Worker", message: overrides.message ?? REQUEST, runId: "run_abcdef123456" },
    result,
  }
}

/** The card body's line height, read from the CSS the web surface ships. */
let CARD_LINE_HEIGHT = 0

beforeAll(() => {
  const css = readFileSync(resolve(import.meta.dir, "../../../../global.css"), "utf8")
  const start = css.indexOf(".chat-md.chat-md-compact p,")
  const rule = css.slice(start, css.indexOf("}", start))
  const match = /line-height:\s*(\d+)px/.exec(rule)
  if (!match) throw new Error("the compact card body line-height is missing from global.css")
  CARD_LINE_HEIGHT = Number(match[1])
})

beforeEach(() => {
  chatContext = null
  document.documentElement.classList.remove("dark")
})
afterEach(cleanup)

function clampHeightPx(testID: string): number {
  const clamp = screen.getByTestId(`${testID}-clamp`)
  const height = Number.parseFloat(clamp.style.maxHeight)
  if (!Number.isFinite(height)) throw new Error(`${testID} is not clamped: maxHeight=${clamp.style.maxHeight}`)
  return height
}

describe("SHO-100 project_call card — markdown bodies", () => {
  test("a markdown reply renders formatted, with no raw syntax left in the text", () => {
    render(<ProjectCallCard tool={tool()} />)
    const reply = screen.getByTestId("project-call-reply")

    expect(reply.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Done.")
    expect(reply.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("bun x tsc")
    expect(reply.querySelectorAll('[data-streamdown="list-item"]').length).toBeGreaterThanOrEqual(2)
    expect(reply.querySelector('[data-streamdown="heading-2"]')?.textContent).toBe("Notes")

    const text = reply.textContent ?? ""
    expect(text).not.toContain("**")
    expect(text).not.toContain("`")
    expect(text).not.toContain("- auth")
  })

  test("the request renders as markdown too — callers pass a multi-line brief", () => {
    render(<ProjectCallCard tool={tool()} />)
    const request = screen.getByTestId("project-call-request")

    expect(request.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Goal:")
    expect(request.querySelectorAll('[data-streamdown="list-item"]').length).toBeGreaterThanOrEqual(2)
    expect(request.textContent).not.toContain("**")
  })

  test("both bodies stay on the card type scale, not the phone chat body", () => {
    render(<ProjectCallCard tool={tool()} />)

    for (const id of ["project-call-request", "project-call-reply"]) {
      const surface = screen.getByTestId(id).querySelector(".chat-md")
      expect(surface?.className).toContain("chat-md-compact")
      expect(surface?.className).not.toContain("chat-md-mobile")
    }
  })

  test("collapsed: at most 2 request lines and 4 reply lines, and never a chopped line", () => {
    render(<ProjectCallCard tool={tool()} />)

    const requestPx = clampHeightPx("project-call-request")
    const replyPx = clampHeightPx("project-call-reply")

    // A clamp that is not a whole number of lines shows a half-glyph row.
    expect(requestPx % CARD_LINE_HEIGHT).toBe(0)
    expect(replyPx % CARD_LINE_HEIGHT).toBe(0)
    expect(requestPx / CARD_LINE_HEIGHT).toBeLessThanOrEqual(2)
    expect(replyPx / CARD_LINE_HEIGHT).toBeLessThanOrEqual(4)
  })

  test("Show more expands the reply and Show less clamps it again", () => {
    render(<ProjectCallCard tool={tool()} />)
    const reply = screen.getByTestId("project-call-reply")
    const before = clampHeightPx("project-call-reply")

    fireEvent.click(within(reply).getByText("Show more"))
    expect(screen.getByTestId("project-call-reply-clamp").style.maxHeight).toBe("")
    expect(within(reply).getByText("Show less")).toBeTruthy()

    fireEvent.click(within(reply).getByText("Show less"))
    expect(clampHeightPx("project-call-reply")).toBe(before)
  })

  test("a failed call keeps its error clamped and expandable — plain text, no markdown", () => {
    render(<ProjectCallCard tool={tool({ error: LONG_ERROR })} />)
    const error = screen.getByTestId("project-call-error")

    expect(screen.getByTestId("project-call-status").textContent).toBe("Failed")
    expect(error.className).toContain("text-destructive")
    expect(error.querySelector(".chat-md")).toBeNull()
    // A long payload must not stretch the card open.
    expect(error.getAttribute("data-number-of-lines")).toBe("4")
    expect(screen.getByText("The callee is still working.")).toBeTruthy()

    fireEvent.click(within(error.parentElement as HTMLElement).getByText("Show more"))
    expect(screen.getByTestId("project-call-error").getAttribute("data-number-of-lines")).toBeNull()
  })

  test("keeps the call controls working: Open chat opens the recorded chat", () => {
    const openProjectPane = mock((_req: unknown) => {})
    chatContext = { openProjectPane, workspaceId: "ws-1" }
    render(<ProjectCallCard tool={tool()} />)

    fireEvent.click(screen.getByLabelText("Open chat with Worker"))
    expect(openProjectPane).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-2",
        chatSessionId: "9b1c2d3e-0000-5000-8000-000000000001",
        tab: "chat",
      }),
    )
  })
})
