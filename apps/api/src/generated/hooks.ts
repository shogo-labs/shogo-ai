// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generated Hooks Aggregator
 * 
 * This file aggregates all hooks from individual model hook files
 */

import {
  userHooks,
  workspaceHooks,
  projectHooks,
  starredProjectHooks,
  memberHooks,
  billingAccountHooks,
  invitationHooks,
  folderHooks,
  notificationHooks,
  subscriptionHooks,
  creditLedgerHooks,
  usageEventHooks,
  chatSessionHooks,
  chatMessageHooks,
  toolCallLogHooks,
  featureSessionHooks
} from './index'

export const routeHooks = {
  user: userHooks,
  workspace: workspaceHooks,
  project: projectHooks,
  starredProject: starredProjectHooks,
  member: memberHooks,
  billingAccount: billingAccountHooks,
  invitation: invitationHooks,
  folder: folderHooks,
  notification: notificationHooks,
  subscription: subscriptionHooks,
  creditLedger: creditLedgerHooks,
  usageEvent: usageEventHooks,
  chatSession: chatSessionHooks,
  chatMessage: chatMessageHooks,
  toolCallLog: toolCallLogHooks,
  featureSession: featureSessionHooks
}
