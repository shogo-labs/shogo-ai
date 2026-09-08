// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, type ScrollViewProps } from 'react-native'

/**
 * iOS overlay indicator only. Web and desktop keep the CSS scrollbar
 * from `global.css`; this helper must not set JS scrollbar styles.
 */
export const overlayScrollbarProps: Pick<ScrollViewProps, 'indicatorStyle'> =
  Platform.OS === 'ios' ? { indicatorStyle: 'white' } : {}
