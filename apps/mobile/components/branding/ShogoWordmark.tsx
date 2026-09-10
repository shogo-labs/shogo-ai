// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useResolvedTheme } from '../../contexts/theme'
import { ShogoWordmark as SharedShogoWordmark } from '@shogo/shared-ui/branding'
import { ShogoLogoMark } from './ShogoLogoMark'

export interface ShogoWordmarkProps {
  /** Tailwind size classes, e.g. `h-5 w-24`. Defaults to the sidebar wordmark size. */
  className?: string
  /** Render the compact mark for tight contexts like the collapsed sidebar rail. */
  compact?: boolean
}

export function ShogoWordmark({ className, compact }: ShogoWordmarkProps) {
  const resolvedTheme = useResolvedTheme()

  if (compact) {
    return <ShogoLogoMark className={className ?? 'h-7 w-7'} />
  }

  return (
    <SharedShogoWordmark
      className={className}
      colorScheme={resolvedTheme === 'dark' ? 'dark' : 'light'}
    />
  )
}
