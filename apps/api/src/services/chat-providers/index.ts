// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { registerChatProvider } from './registry'
import { googleChatProvider } from './google-chat'
import { slackProvider } from './slack'
import { teamsProvider } from './teams'

export function registerBuiltInChatProviders(): void {
  registerChatProvider(slackProvider)
  registerChatProvider(teamsProvider)
  registerChatProvider(googleChatProvider)
}
