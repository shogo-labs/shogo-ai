// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { Animated, Platform, View } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'
import type { useNativeSheetDrawer } from '../../lib/use-native-drawer-swipe'

export interface NativeSheetDrawerShellProps {
  isWide: boolean
  nativeSheetDrawer: boolean
  canvas?: string
  safeAreaEdges?: Edge[]
  sidebarWide: ReactNode
  sidebarSheet: ReactNode
  sidebarOverlay?: ReactNode
  header: ReactNode | null
  children: ReactNode
  drawer: ReturnType<typeof useNativeSheetDrawer>
}

/**
 * Shared two-layer native drawer shell. Breakpoint decisions stay in each
 * route layout; this component only owns the repeated animated composition.
 */
export function NativeSheetDrawerShell({
  isWide,
  nativeSheetDrawer,
  canvas,
  safeAreaEdges,
  sidebarWide,
  sidebarSheet,
  sidebarOverlay,
  header,
  children,
  drawer,
}: NativeSheetDrawerShellProps) {
  const {
    drawerOpen,
    sheetSwipeHandlers,
    sheetStyle,
    sheetClipStyle,
    sheetFill,
    sheetCompositing,
    underlayStyle,
  } = drawer
  const frameFill = nativeSheetDrawer ? (sheetFill ?? canvas) : canvas
  const flattenSheet = nativeSheetDrawer && (drawerOpen || sheetCompositing)
  const frameOverflow =
    nativeSheetDrawer && Platform.OS !== 'web' ? 'visible' : 'hidden'

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      style={frameFill && nativeSheetDrawer ? { backgroundColor: frameFill } : undefined}
      edges={safeAreaEdges}
    >
      <View className="flex-1 flex-row">
        {isWide ? sidebarWide : null}

        <View
          style={[
            { flex: 1, overflow: frameOverflow },
            nativeSheetDrawer && frameFill ? { backgroundColor: frameFill } : undefined,
          ]}
          collapsable={false}
        >
          {nativeSheetDrawer ? (
            <View
              pointerEvents={drawerOpen ? 'auto' : 'none'}
              accessibilityElementsHidden={!drawerOpen}
              importantForAccessibility={drawerOpen ? 'auto' : 'no-hide-descendants'}
              style={underlayStyle}
            >
              {sidebarSheet}
            </View>
          ) : null}
          <Animated.View
            collapsable={false}
            {...sheetSwipeHandlers}
            style={[{ flex: 1, zIndex: 1 }, nativeSheetDrawer ? sheetStyle : undefined]}
          >
            <Animated.View
              collapsable={false}
              style={nativeSheetDrawer ? sheetClipStyle : { flex: 1, overflow: 'hidden' }}
            >
              <View
                className="flex-1"
                collapsable={false}
                shouldRasterizeIOS={flattenSheet}
                renderToHardwareTextureAndroid={flattenSheet}
              >
                {header}
                <View className="flex-1">{children}</View>
              </View>
            </Animated.View>
          </Animated.View>
        </View>
      </View>

      {!isWide && !nativeSheetDrawer ? sidebarOverlay : null}
    </SafeAreaView>
  )
}
