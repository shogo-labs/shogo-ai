// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The top of a phone tab screen: a large title with the profile avatar on the
 * right. Settings, status and notification pausing live behind the avatar, so
 * no tab needs a gear of its own.
 *
 * The title shrinks and softens as the screen's list scrolls, like Wallet. A
 * screen opts in by spreading `useTabScreenScroll()` onto its ScrollView or
 * FlatList; without it the header simply stays put.
 */
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { CreateMenu } from './CreateMenu'
import { ProfileMenu } from './ProfileMenu'

export interface TabScreenHeaderProps {
  title: string
  /** Extra controls left of the avatar. */
  actions?: ReactNode
  /** Replaces the title, e.g. a workspace switcher. */
  titleSlot?: ReactNode
}

/** How far the list scrolls before the title is fully shrunk. */
const COLLAPSE_DISTANCE = 72
const MIN_SCALE = 0.86
const MIN_OPACITY = 0.7

/** Title scale and opacity for a scroll offset: 1 at rest, shrunk once collapsed. */
export function headerCollapse(offsetY: number): { scale: number; opacity: number } {
  const progress = Math.min(1, Math.max(0, offsetY / COLLAPSE_DISTANCE))
  return { scale: 1 - (1 - MIN_SCALE) * progress, opacity: 1 - (1 - MIN_OPACITY) * progress }
}

interface ScrollBinding {
  scrollY: Animated.Value
}
const ScrollContext = createContext<ScrollBinding | null>(null)

/** Props for a ScrollView or FlatList whose scrolling should collapse the tab header. */
export function useTabScreenScroll(): {
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollEventThrottle: number
} {
  const binding = useContext(ScrollContext)
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => binding?.scrollY.setValue(event.nativeEvent.contentOffset.y),
    [binding],
  )
  return { onScroll, scrollEventThrottle: 16 }
}

/**
 * A ScrollView that collapses the tab header. Use it as the body of a
 * `TabScreen`; the hook above is for lists rendered in a child component.
 */
export function TabScreenScrollView({ onScroll, ...props }: ScrollViewProps) {
  const collapse = useTabScreenScroll()
  return (
    <ScrollView
      {...props}
      scrollEventThrottle={collapse.scrollEventThrottle}
      onScroll={(event) => {
        collapse.onScroll(event)
        onScroll?.(event)
      }}
    />
  )
}

export function TabScreenHeader({ title, actions, titleSlot }: TabScreenHeaderProps) {
  const insets = useSafeAreaInsets()
  const binding = useContext(ScrollContext)
  const style = binding
    ? {
        opacity: binding.scrollY.interpolate({ inputRange: [0, COLLAPSE_DISTANCE], outputRange: [1, MIN_OPACITY], extrapolate: 'clamp' }),
        transform: [
          { scale: binding.scrollY.interpolate({ inputRange: [0, COLLAPSE_DISTANCE], outputRange: [1, MIN_SCALE], extrapolate: 'clamp' }) },
        ],
        transformOrigin: 'left center',
      }
    : undefined
  return (
    <View className="flex-row items-center justify-between px-4 pb-2" style={{ paddingTop: insets.top + 8 }} testID="tab-screen-header">
      <Animated.View className="min-w-0 flex-1 pr-3" style={style as any}>
        {titleSlot ?? (
          <Text className="text-[28px] font-bold leading-9 text-foreground" accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
        )}
      </Animated.View>
      <View className="flex-row items-center gap-2">
        {actions}
        <ProfileMenu placement="bottom right" size="md" />
      </View>
    </View>
  )
}

/** The floating "+": ask an agent, start a task or project, or message someone. */
export function FloatingCreate() {
  return (
    <View style={{ position: 'absolute', right: 16, bottom: 28 }} pointerEvents="box-none">
      <CreateMenu placement="top right">
        {({ open, ...props }) => (
          <Pressable
            {...props}
            accessibilityRole="button"
            accessibilityLabel="Create"
            className="h-14 w-14 items-center justify-center rounded-full bg-primary shadow-lg active:opacity-90"
          >
            <Plus size={26} color="#fff" style={{ transform: [{ rotate: open ? '45deg' : '0deg' }] }} />
          </Pressable>
        )}
      </CreateMenu>
    </View>
  )
}

/** A phone tab screen: header, body, and the floating "+". */
export function TabScreen({ testID, children, ...header }: TabScreenHeaderProps & { testID?: string; children: ReactNode }) {
  const scrollY = useRef(new Animated.Value(0)).current
  const binding = useMemo(() => ({ scrollY }), [scrollY])
  return (
    <ScrollContext.Provider value={binding}>
      <View className="flex-1 bg-background" testID={testID}>
        <TabScreenHeader {...header} />
        <View className="flex-1">{children}</View>
        <FloatingCreate />
      </View>
    </ScrollContext.Provider>
  )
}
