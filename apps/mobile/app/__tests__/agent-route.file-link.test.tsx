// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A shared file link is `/agent?workspace=<id>&file=<path>`; the route hands
 * both to the chat screen, which owns what to do with them (SHO-284).
 */

import { expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../test/react-native-mock"

let params: Record<string, string> = {}
const rendered: Array<Record<string, unknown>> = []

mock.module("react-native", () => createReactNativeMock())
mock.module("expo-router", () => ({ useLocalSearchParams: () => params }))
mock.module("../../hooks/useWorkspaceInView", () => ({
  useWorkspaceInView: () => ({ id: "ws-1", name: "Team", kind: "team" }),
}))
mock.module("../../components/team-chat/SessionBreadcrumb", () => ({
  SessionBreadcrumb: () => null,
}))
mock.module("../../components/workspace/WorkspaceAgentChatScreen", () => ({
  WorkspaceAgentChatScreen: (props: Record<string, unknown>) => {
    rendered.push(props)
    return <div data-testid="agent-chat" />
  },
}))

const { render, cleanup } = await import("@testing-library/react")
const { afterEach } = await import("bun:test")
const { default: AgentChatRoute } = await import("../(app)/agent")

afterEach(() => {
  cleanup()
  rendered.length = 0
})

test("a file link's workspace and path reach the chat screen", () => {
  params = { workspace: "ws-9", file: "notes/my plan.md" }
  render(<AgentChatRoute />)

  expect(rendered.at(-1)?.linkWorkspaceId).toBe("ws-9")
  expect(rendered.at(-1)?.initialFilePath).toBe("notes/my plan.md")
})

test("a plain arrival passes no file link", () => {
  params = {}
  render(<AgentChatRoute />)

  expect(rendered.at(-1)?.linkWorkspaceId).toBeNull()
  expect(rendered.at(-1)?.initialFilePath).toBeNull()
})
