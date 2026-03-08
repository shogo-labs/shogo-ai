// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Linking as RNLinking } from 'react-native'

export const linking = {
  openURL(url: string) {
    if (Platform.OS === 'web') {
      window.open(url, '_blank', 'noopener,noreferrer')
    } else {
      RNLinking.openURL(url)
    }
  },

  canOpenURL(url: string): Promise<boolean> {
    if (Platform.OS === 'web') {
      return Promise.resolve(true)
    }
    return RNLinking.canOpenURL(url)
  },
}
