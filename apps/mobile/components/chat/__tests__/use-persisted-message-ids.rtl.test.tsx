// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 AC 7 — the hook ChatPanel actually uses.
 *
 * The adoption usually resolves *after* `sendMessage` appends the bubble (the
 * POST round-trip is slower than the synchronous append) but can also land
 * before it; both orders must end with one bubble carrying the row id, and a
 * later transcript repaint must find the same id (that repaint is what closed
 * the editor mid-stream before).
 */

import { describe, expect, test } from "bun:test"
import { act, render } from "@testing-library/react"
import { createElement, useState } from "react"
import type { UIMessage } from "ai"
import { usePersistedMessageIds } from "../use-persisted-message-ids"
import { OPTIMISTIC_ECHO_ID } from "../optimistic-echo"

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage

function Harness({ initial }: { initial: UIMessage[] }) {
  const [messages, setMessages] = useState<UIMessage[]>(initial)
  const [, tick] = useState(0)
  const { adopt, pendingCount } = usePersistedMessageIds(messages, setMessages)

  return createElement(
    "div",
    null,
    createElement(
      "div",
      { "data-testid": "ids" },
      messages.map((m) => m.id).join(","),
    ),
    createElement(
      "div",
      { "data-testid": "pending" },
      String(pendingCount()),
    ),
    createElement(
      "button",
      {
        "data-testid": "adopt",
        onClick: () => {
          adopt("cmrow123", "alpha one")
          tick((n) => n + 1)
        },
      },
      "adopt",
    ),
    createElement(
      "button",
      {
        "data-testid": "append",
        onClick: () => {
          setMessages((prev) => [...prev, user("nanoid-late", "alpha one")])
          tick((n) => n + 1)
        },
      },
      "append",
    ),
    createElement(
      "button",
      {
        "data-testid": "repaint",
        onClick: () => {
          setMessages([user("cmrow123", "alpha one")])
          tick((n) => n + 1)
        },
      },
      "repaint",
    ),
  )
}

const ids = (view: ReturnType<typeof render>) =>
  view.getByTestId("ids").textContent
const pending = (view: ReturnType<typeof render>) =>
  view.getByTestId("pending").textContent

describe("usePersistedMessageIds", () => {
  test("notifies the panel so id-keyed edit state can move with the swap", () => {
    const swaps: Array<[string, string]> = []
    function WithCallback() {
      const [messages, setMessages] = useState<UIMessage[]>([
        user("etaFabWQxbFogiOw", "alpha one"),
      ])
      const { adopt } = usePersistedMessageIds(
        messages,
        setMessages,
        (from, to) => swaps.push([from, to]),
      )
      return createElement(
        "button",
        { "data-testid": "adopt", onClick: () => adopt("cmrow123", "alpha one") },
        "adopt",
      )
    }
    const view = render(createElement(WithCallback))
    act(() => {
      view.getByTestId("adopt").click()
    })
    expect(swaps).toEqual([["etaFabWQxbFogiOw", "cmrow123"]])
  })

  test("swaps the id of a bubble already on screen", () => {
    const view = render(
      createElement(Harness, { initial: [user("etaFabWQxbFogiOw", "alpha one")] }),
    )
    act(() => {
      view.getByTestId("adopt").click()
    })
    expect(ids(view)).toBe("cmrow123")
    expect(pending(view)).toBe("0")
  })

  test("waits for a bubble that hasn't landed yet, then adopts it", () => {
    const view = render(createElement(Harness, { initial: [] }))
    act(() => {
      view.getByTestId("adopt").click()
    })
    expect(ids(view)).toBe("")
    expect(pending(view)).toBe("1")

    act(() => {
      view.getByTestId("append").click()
    })
    expect(ids(view)).toBe("cmrow123")
    expect(pending(view)).toBe("0")
  })

  test("is idempotent across a transcript repaint from saved rows", () => {
    const view = render(
      createElement(Harness, { initial: [user("etaFabWQxbFogiOw", "alpha one")] }),
    )
    act(() => {
      view.getByTestId("adopt").click()
    })
    act(() => {
      view.getByTestId("repaint").click()
    })
    expect(ids(view)).toBe("cmrow123")
    expect(pending(view)).toBe("0")
  })

  test("leaves the painted echo alone while its bubble is missing", () => {
    const view = render(
      createElement(Harness, { initial: [user(OPTIMISTIC_ECHO_ID, "alpha one")] }),
    )
    act(() => {
      view.getByTestId("adopt").click()
    })
    expect(ids(view)).toBe(OPTIMISTIC_ECHO_ID)
    expect(pending(view)).toBe("1")
  })
})
