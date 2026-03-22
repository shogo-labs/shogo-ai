// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Dimensions, Platform } from 'react-native'

export const dimensions = {
  getWidth(): number {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.innerWidth
    }
    return Dimensions.get('window').width
  },

  getHeight(): number {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.innerHeight
    }
    return Dimensions.get('window').height
  },

  isSmallScreen(): boolean {
    return dimensions.getWidth() < 768
  },

  isMediumScreen(): boolean {
    const w = dimensions.getWidth()
    return w >= 768 && w < 1024
  },

  isLargeScreen(): boolean {
    return dimensions.getWidth() >= 1024
  },
}
