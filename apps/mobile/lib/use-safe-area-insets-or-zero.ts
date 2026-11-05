// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context"

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * `useSafeAreaInsets` throws when no `SafeAreaProvider` is above it. The chat
 * viewers stay mounted inside the composer even while closed, so a tree
 * without a provider (a test, a standalone story) must not crash them: it
 * gets zero insets instead.
 *
 * The hook reads its context before it throws, so catching here never changes
 * the order or number of hooks a render calls.
 */
export function useSafeAreaInsetsOrZero(): EdgeInsets {
  try {
    return useSafeAreaInsets()
  } catch {
    return ZERO_INSETS
  }
}
