// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A push tap (and a cold start from one) has to reach the destination the push
 * named. The invitee's push carries `actionUrl: /invitations/<id>/accept`; the
 * tap is parsed into `{ actionUrl }` and routed there instead of being dropped
 * on the floor, which is what happened while only `url` / `taskId` /
 * `conversationId` / `sessionId` were understood.
 */

import { describe, expect, mock, test } from "bun:test"
import { createElement } from "react"
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
mock.module("../../lib/notifications/alert-title", () => ({ alertTitleFor: (_reason: string, title: string) => title }))
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

describe("invitation push tap", () => {
  test("parses the invitation push into its accept path", () => {
    expect(
      parseClickData({
        notificationType: "invitation_pending",
        invitationId: "inv-1",
        actionUrl: "/invitations/inv-1/accept",
      }),
    ).toEqual({ actionUrl: "/invitations/inv-1/accept" })
  })

  test("routes a tap and a cold start to /invitations/<id>/accept", () => {
    const data = parseClickData({ actionUrl: "/invitations/inv-1/accept" })
    expect(data).not.toBeNull()
    expect(notificationClickHref(data!)).toBe("/invitations/inv-1/accept")
  })

  test("ignores a non-relative actionUrl instead of pushing it", () => {
    expect(parseClickData({ actionUrl: "https://example.com/phish" })).toBeNull()
  })

  test("message and task pushes still route the way they did", () => {
    expect(parseClickData({ taskId: "t-1" })).toEqual({ taskId: "t-1" })
    expect(parseClickData({ conversationId: "c-1", threadRootId: "m-1" })).toEqual({
      conversationId: "c-1",
      threadRootId: "m-1",
    })
    expect(parseClickData({ url: "shogo://agents/planner" })).toEqual({ agentKey: "planner" })
  })
})
