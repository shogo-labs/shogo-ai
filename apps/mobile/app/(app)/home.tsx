// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The home the landing used to be: the work-first feed on a phone and the
 * "What are we building" builder on wide web. `/` lands on the workspace
 * agent instead, so this keeps the old home one tap away (TeamDock, sidebar).
 */
import { HomeScreen } from './index'

export default function TeamHomeScreen() {
  return <HomeScreen explicitHome />
}
