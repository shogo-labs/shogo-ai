// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { SideChatsScreen } from '../../../components/personal/SideChatsScreen'
import { SafeAreaView } from 'react-native-safe-area-context'

/**
 * Keep the chat surface self-contained while the route provides the safe-area
 * boundary used by the rest of the Muse-inspired workspace routes.
 */
export default function SideChatsRoute() {
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'left', 'right']}>
      <SideChatsScreen />
    </SafeAreaView>
  )
}
