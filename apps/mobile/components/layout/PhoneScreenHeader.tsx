// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone navigation standard: one floating glass header for every screen you
 * push and every full-screen pane. It is the DM header (a 44px glass Back, a
 * glass title pill, glass trailing actions) with nothing behind it — no bar, no
 * border, no fill — so the screen's content scrolls under the glass.
 *
 * Screens pad themselves by the header's measured height with
 * `usePhoneScreenHeaderInset()`, exactly like the conversation screen does with
 * `ConversationHeader`'s `onLayout`.
 */
import { createContext, useCallback, useContext, useState, type Context, type ReactNode } from 'react'
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
// A namespace import, not a named one: bun's CJS interop cannot see this
// package's re-exported names, and a suite that mocks only the hook would
// otherwise take the header down at import time.
import * as safeAreaModule from 'react-native-safe-area-context'
import type { EdgeInsets } from 'react-native-safe-area-context'
import { ChevronLeft, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'
import { CHROME_SIZE, GlassButton } from '../team-chat/FloatingChrome'

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** Stands in where the safe-area package exposes no context (a partial mock). */
const NO_PROVIDER = createContext<EdgeInsets | null>(null)

const InsetsContext =
  (safeAreaModule as { SafeAreaInsetsContext?: Context<EdgeInsets | null> }).SafeAreaInsetsContext ??
  NO_PROVIDER

/**
 * The safe-area insets, as every phone screen reads them.
 *
 * Read from the context rather than `useSafeAreaInsets`, which throws where no
 * provider is mounted (a pane rendered on its own, a test tree): with none the
 * header draws at the top of its parent instead of crashing. The app mounts a
 * provider in `app/_layout.tsx`, so every real screen gets its insets.
 */
function useInsets(): EdgeInsets {
  return useContext(InsetsContext) ?? ZERO_INSETS
}

/** Breathing room between the status bar and the glass controls. */
export const PHONE_SCREEN_HEADER_TOP_GAP = 6

/** The header's height before it has been measured: safe area + gap + one row. */
export function phoneScreenHeaderHeight(topInset: number): number {
  return topInset + PHONE_SCREEN_HEADER_TOP_GAP + CHROME_SIZE
}

const PILL_CLASS = 'min-w-0 flex-shrink justify-center overflow-hidden rounded-full bg-transparent px-4 shadow-sm'

export interface PhoneTitlePillProps {
  title: string
  subtitle?: string | null
  /** Rendered before the title inside the pill, e.g. a small icon. */
  titleIcon?: ReactNode
  /** Makes the pill tappable. Without it the pill is a plain label. */
  onPress?: () => void
  /** Accessibility label. Defaults to the title. */
  titleLabel?: string
  /** Fades the pill's contents without unmounting them (the details panel takes over). */
  titleOpacity?: number
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
  testID?: string
}

/** The glass title pill that sits between Back and the actions. */
export function PhoneTitlePill({
  title,
  subtitle,
  titleIcon,
  onPress,
  titleLabel,
  titleOpacity,
  onLayout,
  style,
  testID,
}: PhoneTitlePillProps) {
  const contents = (
    <>
      <LiquidGlassBackdrop style={{ borderRadius: CHROME_SIZE / 2 }} />
      <View style={titleOpacity === undefined ? undefined : { opacity: titleOpacity }}>
        <View className="flex-row items-center gap-1.5">
          {titleIcon}
          <Text className="flex-shrink text-[15px] font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
        </View>
        {subtitle ? (
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </>
  )
  const pillStyle = [{ height: CHROME_SIZE }, style]
  if (!onPress) {
    return (
      <View
        onLayout={onLayout}
        accessible
        accessibilityLabel={titleLabel ?? title}
        className={PILL_CLASS}
        style={pillStyle}
        testID={testID}
      >
        {contents}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityLabel={titleLabel ?? title}
      className={PILL_CLASS}
      style={pillStyle}
      testID={testID}
    >
      {contents}
    </Pressable>
  )
}

export interface PhoneScreenHeaderProps {
  title: string
  subtitle?: string | null
  /** Shows a glass Back chevron. */
  onBack?: () => void
  /** Shows a glass Close instead of Back, for a pane. Ignored when `onBack` is set. */
  onClose?: () => void
  /** Accessibility label for the Back control. Defaults to "Back". */
  backLabel?: string
  /** Accessibility label for the Close control. Defaults to "Close". */
  closeLabel?: string
  /** testID for the Back control, for tests that named the old back row. */
  backTestID?: string
  /** testID for the Close control, for tests that named the old close button. */
  closeTestID?: string
  /** Rendered before the title inside the pill, e.g. a small icon. */
  titleIcon?: ReactNode
  /** Makes the title pill tappable. */
  onTitlePress?: () => void
  /** Accessibility label for the title pill. Defaults to the title. */
  titleLabel?: string
  /** Glass buttons on the right. */
  actions?: ReactNode
  /** Extra chrome under the row, e.g. filter chips or a banner. */
  children?: ReactNode
  /** Reports the measured height, so the screen can pad its content. */
  onLayout?: (event: LayoutChangeEvent) => void
  /** Offset from the top of the screen, for a header that sits under another one. */
  top?: number
  /** Overrides the status-bar gap; 0 when the header follows another header. */
  paddingTop?: number
  /** Extra classes on the row, e.g. a bottom gap before a banner. */
  rowClassName?: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function PhoneScreenHeader({
  title,
  subtitle,
  onBack,
  onClose,
  backLabel = 'Back',
  closeLabel = 'Close',
  backTestID,
  closeTestID,
  titleIcon,
  onTitlePress,
  titleLabel,
  actions,
  children,
  onLayout,
  top = 0,
  paddingTop,
  rowClassName,
  style,
  testID = 'phone-screen-header',
}: PhoneScreenHeaderProps) {
  const insets = useInsets()
  const close = !onBack && !!onClose

  return (
    <View
      pointerEvents="box-none"
      onLayout={onLayout}
      className="absolute left-0 right-0 z-30 px-3"
      style={[{ top, paddingTop: paddingTop ?? insets.top + PHONE_SCREEN_HEADER_TOP_GAP }, style]}
      testID={testID}
    >
      <View pointerEvents="box-none" className={cn('flex-row items-center gap-2', rowClassName)}>
        {onBack ? (
          <GlassButton label={backLabel} onPress={onBack} testID={backTestID}>
            <ChevronLeft size={22} className="text-foreground" />
          </GlassButton>
        ) : close ? (
          <GlassButton label={closeLabel} onPress={onClose} testID={closeTestID}>
            <X size={20} className="text-foreground" />
          </GlassButton>
        ) : null}
        <PhoneTitlePill
          title={title}
          subtitle={subtitle}
          titleIcon={titleIcon}
          onPress={onTitlePress}
          titleLabel={titleLabel}
          testID="phone-screen-header-title"
        />
        <View className="flex-1" pointerEvents="none" />
        {actions ? <View className="flex-row items-center gap-2">{actions}</View> : null}
      </View>
      {children}
    </View>
  )
}

/**
 * Top padding for a screen whose header is one row (Back + title pill) and
 * never changes height, so it need not be measured.
 */
export function usePhoneScreenHeaderPadding(): number {
  const insets = useInsets()
  return phoneScreenHeaderHeight(insets.top)
}

/**
 * The top padding a screen owes its content so nothing hides under the glass.
 * Falls back to the unmeasured height on the first frame, so content never
 * jumps up before `onLayout` fires.
 */
export function usePhoneScreenHeaderInset(): {
  /** Padding for the screen's content (ScrollView `contentContainerStyle.paddingTop`). */
  height: number
  /** Spread onto the header's `onLayout`. */
  onLayout: (event: LayoutChangeEvent) => void
} {
  const insets = useInsets()
  const [measured, setMeasured] = useState(0)
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setMeasured(Math.round(event.nativeEvent.layout.height))
  }, [])
  return { height: measured || phoneScreenHeaderHeight(insets.top), onLayout }
}
