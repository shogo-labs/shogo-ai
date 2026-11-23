// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { ActivityIndicator, Platform, type ActivityIndicatorProps } from 'react-native'
import { cssInterop } from 'nativewind'
import { cn } from './cn'

/**
 * react-native-web's ActivityIndicator falls back to a hardcoded #1976D2 when
 * no `color` prop is given, which ignores the app's accent and light/dark mode.
 *
 * The `className` path alone is not enough on web: `nativeStyleToProp` is a
 * native-only part of cssInterop, and the web runtime parks the className in
 * `props.style` as a `$$css` marker without lifting `style.color` into the
 * `color` prop. RNW then draws its circles with the `#1976D2` default, so the
 * spinner has to be handed a concrete colour on web. `rgb(var(--color-…))` is
 * that colour: the browser resolves the var from global.css (and the accent
 * provider overrides it), so the spinner still follows the live accent.
 *
 * Native keeps the className path — `rgb(var(--color-…))` is not a colour React
 * Native can parse, and there cssInterop does lift `style.color` for us.
 */
cssInterop(ActivityIndicator, {
  className: { target: 'style', nativeStyleToProp: { color: true } },
})

export type SpinnerTone =
  | 'primary'
  | 'onPrimary'
  | 'muted'
  | 'destructive'
  | 'onDestructive'
  /** Fixed white on a non-theme surface (the `brand` button's landing orange). */
  | 'onBrand'

const TONE_CLASS: Record<SpinnerTone, string> = {
  primary: 'text-primary',
  onPrimary: 'text-primary-foreground',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive',
  onDestructive: 'text-destructive-foreground',
  onBrand: 'text-white',
}

const TONE_WEB_COLOR: Record<SpinnerTone, string> = {
  primary: 'rgb(var(--color-primary))',
  onPrimary: 'rgb(var(--color-primary-foreground))',
  muted: 'rgb(var(--color-muted-foreground))',
  destructive: 'rgb(var(--color-destructive))',
  onDestructive: 'rgb(var(--color-destructive-foreground))',
  onBrand: 'rgb(255, 255, 255)',
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
      color={color ?? (Platform.OS === 'web' ? TONE_WEB_COLOR[tone] : undefined)}
      className={cn(TONE_CLASS[tone], className)}
    />
  )
})

Spinner.displayName = 'Spinner'
