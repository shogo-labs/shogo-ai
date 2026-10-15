// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Your own direct message is the one row whose leading slot is you. A direct
 * message names the other person and shows their presence there; nothing sits
 * across from you in your own conversation, so it carries your face instead.
 * It used to carry a notes icon, which said nothing about who the row was.
 */

import { resolve } from "node:path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return { Bot: Icon, ChevronDown: Icon, ChevronRight: Icon, Hash: Icon, Lock: Icon, Pencil: Icon, Plus: Icon, Radio: Icon, Users: Icon }
})
mock.module(resolve(import.meta.dir, "../PresenceDot"), () => ({
  PresenceDot: ({ userId }: { userId: string }) => createElement("span", { "data-presence": userId }),
}))

const { ConversationRow } = await import("../ConversationRows")

const me = (over: Record<string, unknown> = {}) => ({ type: "user", id: "me", name: "Me Myself", image: null, self: true, ...over })
const ana = { type: "user", id: "ana", name: "Ana Lopez", image: null }

const dm = (participants: unknown[]): any => ({
  id: "c1",
  workspaceId: "w1",
  kind: "dm" as const,
  name: null,
  slug: null,
  topic: null,
  lastSeq: 1,
  lastMessageAt: null,
  archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  joined: true,
  starred: false,
  muted: false,
  notifyLevel: "all",
  lastReadSeq: 0,
  unreadCount: 0,
  mentionCount: 0,
  participants,
})

const row = (participants: unknown[]) =>
  render(createElement(ConversationRow, { conversation: dm(participants), workspaceId: "w1", onPress: () => {} }))

afterEach(cleanup)

describe("your own direct message row", () => {
  test("shows your picture where you are the person the row names", () => {
    const { container } = row([me({ image: "https://cdn.example.com/me.png" })])

    const img = container.querySelector("img")
    expect(img).toBeTruthy()
    expect(img?.getAttribute("accessibilitylabel")).toBe("Me Myself avatar")
  })

  test("falls back to your initial, since a picture is optional", () => {
    const { container } = row([me()])

    expect(container.querySelector("img")).toBeNull()
    expect(screen.getByText("M")).toBeTruthy()
  })

  test("carries no presence dot: nobody is across from you to be present", () => {
    const { container } = row([me()])

    expect(container.querySelector("[data-presence]")).toBeNull()
  })

  test("another person's row is untouched and still shows their presence", () => {
    const { container } = row([ana])

    expect(container.querySelector("[data-presence]")?.getAttribute("data-presence")).toBe("ana")
    expect(container.querySelector("img")).toBeNull()
  })
})
