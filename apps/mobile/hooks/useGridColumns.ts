// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useWindowDimensions } from 'react-native'

/**
 * Returns the number of columns the marketplace grid should render at
 * the current window width. Breakpoints mirror common tablet/desktop
 * layouts so the grid feels right on phones, foldables, and web.
 *
 *   <  480px  →  1 column   (phones, narrow web)
 *   <  768px  →  2 columns  (foldables, small tablets)
 *   < 1080px  →  3 columns  (tablets, narrow desktop)
 *   >= 1080px →  4 columns  (full desktop)
 */
export function useGridColumns(): 1 | 2 | 3 | 4 {
  const { width } = useWindowDimensions()
  if (width < 480) return 1
  if (width < 768) return 2
  if (width < 1080) return 3
  return 4
}
