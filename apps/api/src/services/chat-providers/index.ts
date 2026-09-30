// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { registerChatProvider } from './registry'
import { slackProvider } from './slack'

export function registerBuiltInChatProviders(): void {
  registerChatProvider(slackProvider)
}
