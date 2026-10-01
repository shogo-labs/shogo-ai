// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { cn } from '@shogo/shared-ui/primitives'
import { SHOGO_MARK_FILL, SHOGO_MARK_PATHS, SHOGO_MARK_VIEW_BOX } from './shogo-mark-paths'

export interface ShogoLogoMarkProps {
  /** Tailwind size classes, e.g. `h-6 w-6`. Default matches sidebar (`h-8 w-8`). */
  className?: string
  /** Defaults to the brand orange. */
  fill?: string
}

export function ShogoLogoMark({ className, fill = SHOGO_MARK_FILL }: ShogoLogoMarkProps) {
  return (
    <View
      className={cn('h-8 w-8 shrink-0', className)}
      role="img"
      accessibilityLabel="Shogo"
    >
      <Svg width="100%" height="100%" viewBox={SHOGO_MARK_VIEW_BOX} preserveAspectRatio="xMidYMid meet">
        {SHOGO_MARK_PATHS.map((path, index) => (
          <Path key={index} d={path} fill={fill} />
        ))}
      </Svg>
    </View>
  )
}
