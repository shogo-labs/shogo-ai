// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Embedded AskUserQuestionWidget (the ChatDock blocking panel) must not
 * nest a second "Questions" card, and must keep prompt + Submit pinned
 * while only the option list scrolls.
 */
import { describe, expect, mock, test } from "bun:test"
import { act, render, screen, within } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())

const asyncStorageBacking = new Map<string, string>()
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => asyncStorageBacking.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      asyncStorageBacking.set(k, v)
    },
    removeItem: async (k: string) => {
      asyncStorageBacking.delete(k)
    },
  },
}))

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("../../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))

const { AskUserQuestionWidget } = await import("../AskUserQuestionWidget")
const { ChatContextProvider } = await import("../../ChatContext")
const toolTypes = await import("../../tools/types")

const OPTIONS = [
  { label: "Business Strategy", description: "Market analysis" },
  { label: "Technical Architecture", description: "Tech stack" },
  { label: "Full Pitch Deck", description: "Investor narrative" },
  { label: "All of the Above", description: "Everything" },
  { label: "AI / ML Powered", description: "Core differentiator" },
  { label: "Consumer App", description: "End users" },
]

function pendingTool(overrides: Record<string, unknown> = {}) {
  return {
    id: "call-embed",
    toolName: "ask_user",
    category: toolTypes.getToolCategory("ask_user"),
    state: "input-available" as never,
    args: {
      questions: [
        {
          header: "Planning",
          question: "What kind of startup planning are you looking for?",
          options: OPTIONS,
        },
        {
          header: "Audience",
          question: "Who is this for?",
          options: [{ label: "Founders", description: "Building a company" }],
        },
      ],
    },
    result: undefined,
    timestamp: 0,
    ...overrides,
  }
}

describe("AskUserQuestionWidget embedded in the chat dock", () => {
  test("drops the inner Questions chrome and only scrolls options", async () => {
    const { container } = render(
      <AskUserQuestionWidget
        tool={pendingTool()}
        onSubmitResponse={() => {}}
        embedded
        bodyMaxHeight={180}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByText("Questions")).toBeNull()
    expect(
      screen.getByText("What kind of startup planning are you looking for?"),
    ).toBeTruthy()
    expect(screen.getByText("1 of 2")).toBeTruthy()
    expect(screen.getByText("Next")).toBeTruthy()

    const scroller = container.querySelector(
      '[data-rn-shim="ask-user-question-options"]',
    )
    expect(scroller).toBeTruthy()
    expect((scroller as HTMLElement).style.maxHeight).toBe("180px")
    expect(within(scroller as HTMLElement).queryByText("Next")).toBeNull()
    expect(
      within(scroller as HTMLElement).getAllByText("Business Strategy").length,
    ).toBeGreaterThan(0)
  })

  test("does not wrap a short option list in a ScrollView", async () => {
    const { container } = render(
      <AskUserQuestionWidget
        tool={pendingTool({
          args: {
            questions: [
              {
                header: "Trip",
                question: "Where are you looking to go?",
                options: OPTIONS.slice(0, 3),
              },
            ],
          },
        })}
        onSubmitResponse={() => {}}
        embedded
        bodyMaxHeight={180}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText("Where are you looking to go?")).toBeTruthy()
    expect(container.querySelector('[data-rn-shim="ask-user-question-options"]')).toBeNull()
  })

  test("uses a two-column image grid with titles below each option", async () => {
    const { container } = render(
      <ChatContextProvider
        value={{
          currentSession: null,
          messages: [],
          sendMessage: () => {},
          isLoading: false,
          error: null,
          agentUrl: "https://agent.example.test",
        }}
      >
        <AskUserQuestionWidget
          tool={pendingTool({
            args: {
              questions: [
                {
                  header: "Avatar",
                  question: "Which mermaid should be my avatar?",
                  options: [
                    {
                      label: "Ethereal painterly",
                      description: "Luminous teal-haired mermaid",
                      imagePath: "images/mermaid-a.png",
                    },
                    {
                      label: "Anime",
                      description: "Coral-pink hair and aqua eyes",
                      imagePath: "images/mermaid-b.png",
                    },
                  ],
                },
              ],
            },
          })}
          onSubmitResponse={() => {}}
          embedded
        />
      </ChatContextProvider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    const grid = container.querySelector(
      '[data-rn-shim="ask-user-image-options"]',
    )
    expect(grid).toBeTruthy()
    expect(grid?.className).toContain("flex-row")
    expect(grid?.className).toContain("flex-wrap")
    expect(screen.getByText("Ethereal painterly")).toBeTruthy()
    expect(screen.getByText("Anime")).toBeTruthy()
    expect(
      container.querySelector(
        'img[accessibilitylabel="Preview for option: Ethereal painterly"]',
      ),
    ).toBeTruthy()
  })

  test("embedded loading does not nest a second Questions title", async () => {
    render(
      <AskUserQuestionWidget
        tool={pendingTool({
          state: "streaming",
          args: { questions: [] },
        })}
        onSubmitResponse={() => {}}
        embedded
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText("Loading…")).toBeTruthy()
    expect(screen.queryByText("Questions")).toBeNull()
  })
})
