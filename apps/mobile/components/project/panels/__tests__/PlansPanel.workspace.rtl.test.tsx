// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * PlansPanel hosted outside a project: the team Workspace Agent Chat opens it
 * beside the chat against the workspace runtime's agent-proxy, with no
 * projectId, and dismisses it from the panel's own header.
 */
import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module(resolve(import.meta.dir, "../../../chat/MarkdownText"), () => ({
  MarkdownText: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}))

mock.module(resolve(import.meta.dir, "../../../chat/ChatInput"), () => ({
  DEFAULT_MODEL: "test-model",
}))

mock.module(resolve(import.meta.dir, "../../../chat/PlanBuildActions"), () => ({
  PlanBuildActions: () => null,
}))

mock.module(resolve(import.meta.dir, "../../../../lib/dual-plan-preference"), () => ({
  useDualPlan: () => [false, async () => {}],
}))

const requestedUrls: string[] = []

mock.module(resolve(import.meta.dir, "../../../../lib/agent-fetch"), () => ({
  agentFetch: async (input: RequestInfo | URL) => {
    const url = String(input)
    requestedUrls.push(url)
    const body = url.endsWith("/agent/plans")
      ? {
          plans: [
            {
              filename: "launch_abc.plan.md",
              name: "Launch plan",
              overview: "Ship it",
              createdAt: "2026-10-16T00:00:00.000Z",
              status: "pending",
            },
          ],
        }
      : {
          filename: "launch_abc.plan.md",
          content: "---\nname: \"Launch plan\"\n---\n\n# Launch plan\n\nFull plan body",
        }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
}))

const { PlansPanel } = await import("../PlansPanel")
const { PlanStreamProvider, usePlanStream } = await import("../../../chat/PlanStreamContext")
type PlanStreamContextValue = ReturnType<typeof usePlanStream>

function renderWithPlanStream(ui: ReactNode) {
  const ref: { current: PlanStreamContextValue | null } = { current: null }
  function Capture() {
    ref.current = usePlanStream()
    return null
  }
  const wrap = (node: ReactNode) => (
    <PlanStreamProvider>
      <Capture />
      {node}
    </PlanStreamProvider>
  )
  const result = render(wrap(ui))
  return {
    stream: () => ref.current!,
    rerender: (next: ReactNode) => result.rerender(wrap(next)),
  }
}

function streamingPlan(plan: string) {
  return { name: "Streaming plan", overview: "Still writing", plan, todos: [] }
}

const WORKSPACE_AGENT_URL = "http://api.test/api/workspaces/ws-1/agent-proxy"

describe("PlansPanel in the workspace side pane", () => {
  beforeEach(() => {
    requestedUrls.length = 0
  })

  test("opens the requested plan from the workspace runtime without a projectId", async () => {
    render(
      <PlansPanel
        visible
        agentUrl={WORKSPACE_AGENT_URL}
        requestedPlanPath={{ filepath: ".shogo/plans/launch_abc.plan.md", nonce: 1 }}
      />,
    )

    await waitFor(() => expect(screen.getByText(/Full plan body/)).toBeTruthy())
    expect(requestedUrls).toContain(`${WORKSPACE_AGENT_URL}/agent/plans/launch_abc.plan.md`)
    expect(requestedUrls.some((url) => url.includes("/api/projects/"))).toBe(false)
  })

  test("renders a close button only when onClose is provided", async () => {
    const onClose = mock(() => {})
    const { rerender } = render(<PlansPanel visible agentUrl={WORKSPACE_AGENT_URL} />)
    await waitFor(() => expect(screen.getByText("Launch plan")).toBeTruthy())
    expect(screen.queryByLabelText("Close plans panel")).toBeNull()

    rerender(<PlansPanel visible agentUrl={WORKSPACE_AGENT_URL} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText("Close plans panel"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("PlansPanel with a streaming plan", () => {
  test("lists the streaming plan alongside saved plans", async () => {
    const { stream } = renderWithPlanStream(<PlansPanel visible agentUrl={WORKSPACE_AGENT_URL} />)
    act(() => {
      stream().setIsPlanStreaming(true)
      stream().setStreamingPlan(streamingPlan("Step one"))
    })

    await waitFor(() => expect(screen.getByText("Launch plan")).toBeTruthy())
    expect(screen.getByText("Streaming plan")).toBeTruthy()
    expect(screen.getByText("Generating...")).toBeTruthy()
  })

  test("a request without a filepath opens the streaming plan once it arrives", async () => {
    const { stream } = renderWithPlanStream(
      <PlansPanel
        visible
        agentUrl={WORKSPACE_AGENT_URL}
        requestedPlanPath={{ filepath: null, nonce: 1 }}
      />,
    )
    await waitFor(() => expect(screen.getByText("Launch plan")).toBeTruthy())

    act(() => {
      stream().setIsPlanStreaming(true)
      stream().setStreamingPlan(streamingPlan("Step one"))
    })

    await waitFor(() => expect(screen.getByText("Step one")).toBeTruthy())
    expect(screen.getByLabelText("Back to plans")).toBeTruthy()
  })

  test("going back to the list mid-stream stays on the list", async () => {
    const { stream, rerender } = renderWithPlanStream(
      <PlansPanel visible agentUrl={WORKSPACE_AGENT_URL} requestedPlanPath={null} />,
    )
    act(() => {
      stream().setIsPlanStreaming(true)
      stream().setStreamingPlan(streamingPlan("Step one"))
    })
    rerender(
      <PlansPanel
        visible
        agentUrl={WORKSPACE_AGENT_URL}
        requestedPlanPath={{ filepath: null, nonce: 2 }}
      />,
    )
    await waitFor(() => expect(screen.getByText("Step one")).toBeTruthy())

    fireEvent.click(screen.getByLabelText("Back to plans"))
    act(() => {
      stream().setStreamingPlan(streamingPlan("Step one\n\nStep two"))
    })

    await waitFor(() => expect(screen.getByText("Launch plan")).toBeTruthy())
    expect(screen.getByText("Streaming plan")).toBeTruthy()
    expect(screen.queryByLabelText("Back to plans")).toBeNull()

    fireEvent.click(screen.getByText("Streaming plan"))
    await waitFor(() => expect(screen.getByText(/Step two/)).toBeTruthy())
  })
})
