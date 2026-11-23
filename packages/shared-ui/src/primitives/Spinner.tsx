// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { ActivityIndicator, type ActivityIndicatorProps } from 'react-native'
import { cssInterop } from 'nativewind'
import { cn } from './cn'

/**
 * react-native-web's ActivityIndicator falls back to a hardcoded #1976D2 when
 * no `color` prop is given, which ignores the app's accent and light/dark mode.
 * Lifting the resolved `text-*` class into the `color` prop keeps the spinner on
 * the live theme tokens on both web and native.
 */
cssInterop(ActivityIndicator, {
  className: { target: 'style', nativeStyleToProp: { color: true } },
})

export type SpinnerTone = 'primary' | 'onPrimary' | 'muted' | 'destructive' | 'onDestructive'

const TONE_CLASS: Record<SpinnerTone, string> = {
  primary: 'text-primary',
  onPrimary: 'text-primary-foreground',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive',
  onDestructive: 'text-destructive-foreground',
}

export interface SpinnerProps extends Omit<ActivityIndicatorProps, 'color' | 'className'> {
  /** Theme token the spinner is painted with. Defaults to the accent. */
  tone?: SpinnerTone
  /** Layout / sizing classes only — colour comes from `tone`. */
  className?: string
  /** Escape hatch for a genuinely non-theme colour (e.g. a third-party brand surface). */
  color?: string
}

export const Spinner = React.forwardRef<
  React.ComponentRef<typeof ActivityIndicator>,
  SpinnerProps
>(function Spinner(
  {
    tone = 'primary',
    className,
    color,
    focusable = false,
    'aria-label': ariaLabel = 'loading',
    ...props
  },
  ref,
) {
  return (
    <ActivityIndicator
      ref={ref}
      focusable={focusable}
      aria-label={ariaLabel}
      {...props}
      color={color}
      className={cn(TONE_CLASS[tone], className)}
    />
  )
})

Spinner.displayName = 'Spinner'
