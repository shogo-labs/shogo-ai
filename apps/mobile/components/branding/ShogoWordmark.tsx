// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Text } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface ShogoWordmarkProps {
  /** Tailwind classes for sizing, e.g. `text-2xl`. Defaults to `text-xl`. */
  className?: string
  /**
   * Render the compact mark (`s.`) for tight contexts like the collapsed
   * sidebar rail, where the full wordmark would not fit.
   */
  compact?: boolean
}

/**
 * The Shogo wordmark: lowercase `shogo` with a brand-orange period — the same
 * logo the marketing site renders (see `shogo-website` `Wordmark.tsx`).
 *
 * Theme-aware: the word uses `text-foreground` and the period uses
 * `text-primary` (the app's brand orange), so it adapts to light/dark mode.
 */
export function ShogoWordmark({ className, compact }: ShogoWordmarkProps) {
  return (
    <Text
      className={cn('font-bold tracking-tight text-foreground', className ?? 'text-xl')}
      role="image"
      accessibilityLabel="Shogo"
    >
      {compact ? 's' : 'shogo'}
      <Text className="text-primary">.</Text>
    </Text>
  )
}
