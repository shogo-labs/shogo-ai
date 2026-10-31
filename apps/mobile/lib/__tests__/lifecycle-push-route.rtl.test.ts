// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A lifecycle push tap (build-ready / credits-reset) has to land on the project
 * it was about, flagged as that arrival, so the project chat can greet the
 * person with the "Continue <project>" chip (SHO-266).
 *
 * The two pushes carry different payloads: build-ready knows the turn's
 * session, credits-reset only the project (whose most recently active chat the
 * project screen opens by default). A plain chat-completion push must route the
 * way it always did — no chip.
 */

import { describe, expect, mock, test } from "bun:test"
import { createReactNativeMock } from "../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "ios" } }),
)
mock.module("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module("expo-notifications", () => ({
  addNotificationResponseReceivedListener: () => ({ remove: () => {} }),
  getLastNotificationResponseAsync: async () => null,
  clearLastNotificationResponseAsync: async () => {},
  setNotificationHandler: () => {},
  setNotificationChannelAsync: async () => {},
  scheduleNotificationAsync: async () => "id",
  getPermissionsAsync: async () => ({ status: "granted", canAskAgain: true }),
  requestPermissionsAsync: async () => true,
}))
mock.module("../../lib/agent-glance", () => ({
  parseAgentDeepLink: (url: string) =>
    url.startsWith("shogo://agents/") ? url.replace("shogo://agents/", "") : null,
}))
mock.module("../../lib/notifications/alert-title", () => ({
  alertTitleFor: (_reason: string, title: string) => title,
}))
mock.module("../../lib/approval-decision", () => ({ answerApproval: async () => {} }))
mock.module("../../lib/approval-lock", () => ({
  getRequireBiometricApproval: async () => false,
  subscribeRequireBiometricApproval: () => () => {},
}))
mock.module("../../lib/notifications/agent-actions", () => ({
  APPROVAL_CATEGORY: "agent-approval",
  approvalActionFrom: () => null,
  approvalCategoryActions: () => [],
  failedAnswerBody: () => "",
}))
mock.module("../../lib/notifications/huddle-call-actions", () => ({
  HUDDLE_CALLS_CHANNEL: "huddle-calls",
  HUDDLE_CALL_CATEGORY: "huddle-call",
  huddleCallActionFrom: () => null,
  huddleCallCategoryActions: () => [],
}))

const { parseClickData } = await import("../notifications/chat-notifier.native")
const { notificationClickHref } = await import("../notifications/useNotificationClickRouter")
const { lifecycleNotificationKind } = await import("../notifications/lifecycle-click")

describe("lifecycle push tap", () => {
  test("reads the lifecycle kind off the push type", () => {
    expect(lifecycleNotificationKind("build-ready")).toBe("build-ready")
    expect(lifecycleNotificationKind("credits-reset")).toBe("credits-reset")
    expect(lifecycleNotificationKind("chat-complete")).toBeNull()
    expect(lifecycleNotificationKind(undefined)).toBeNull()
  })

  test("a build-ready push keeps the session the turn belongs to", () => {
    expect(
      parseClickData({ type: "build-ready", sessionId: "s-1", projectId: "p-1" }),
    ).toEqual({ projectId: "p-1", sessionId: "s-1", lifecycle: "build-ready" })
  })

  test("a credits-reset push has only the project", () => {
    expect(parseClickData({ type: "credits-reset", projectId: "p-1" })).toEqual({
      projectId: "p-1",
      sessionId: null,
      lifecycle: "credits-reset",
    })
  })

  test("the tap opens the project flagged as a lifecycle arrival", () => {
    const data = parseClickData({ type: "build-ready", sessionId: "s-1", projectId: "p-1" })
    expect(notificationClickHref(data!)).toEqual({
      pathname: "/(app)/projects/[id]",
      params: { id: "p-1", fromLifecycle: "build-ready", chatSessionId: "s-1" },
    })
  })

  test("credits-reset omits the session so the project's last chat opens", () => {
    const data = parseClickData({ type: "credits-reset", projectId: "p-1" })
    expect(notificationClickHref(data!)).toEqual({
      pathname: "/(app)/projects/[id]",
      params: { id: "p-1", fromLifecycle: "credits-reset" },
    })
  })

  test("an ordinary chat-completion push still routes without a lifecycle flag", () => {
    const data = parseClickData({ sessionId: "s-1", projectId: "p-1" })
    expect(data).toEqual({ sessionId: "s-1", projectId: "p-1" })
    expect(notificationClickHref(data!)).toEqual({
      pathname: "/(app)/projects/[id]",
      params: { id: "p-1", chatSessionId: "s-1" },
    })
  })
})
