// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo, useState, type ReactNode } from 'react'
import { Animated, Platform, View } from 'react-native'
import { SafeAreaView, type Edge, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { useNativeSheetDrawer } from '../../lib/use-native-drawer-swipe'
import { PhoneChromeOverlayContext } from './PhoneChromeOverlay'
import { useWidePanelVisible, WidePanelProvider } from './sidebar/WidePanelContext'

export interface NativeSheetDrawerShellProps {
  isWide: boolean
  nativeSheetDrawer: boolean
  canvas?: string
  safeAreaEdges?: Edge[]
  sidebarWide: ReactNode
  sidebarSheet: ReactNode
  sidebarOverlay?: ReactNode
  /**
   * Mount `sidebarSheet` only while the drawer is open (or animating). On a
   * phone the full sidebar used to stay mounted behind every screen; it is
   * expensive and invisible. Wide layouts keep it mounted as before.
   */
  lazySidebarSheet?: boolean
  header: ReactNode | null
  bottomNav?: ReactNode | null
  /** Float `bottomNav` over the content instead of stacking it below. */
  overlayBottomNav?: boolean
  children: ReactNode
  drawer: ReturnType<typeof useNativeSheetDrawer>
}

/**
 * Shared two-layer native drawer shell. Breakpoint decisions stay in each
 * route layout; this component only owns the repeated animated composition.
 */
export function NativeSheetDrawerShell(props: NativeSheetDrawerShellProps) {
  return (
    <WidePanelProvider>
      <NativeSheetDrawerShellFrame {...props} />
    </WidePanelProvider>
  )
}

function NativeSheetDrawerShellFrame({
  isWide,
  nativeSheetDrawer,
  canvas,
  safeAreaEdges,
  sidebarWide,
  sidebarSheet,
  sidebarOverlay,
  lazySidebarSheet = false,
  header,
  bottomNav = null,
  overlayBottomNav = false,
  children,
  drawer,
}: NativeSheetDrawerShellProps) {
  const [navHeight, setNavHeight] = useState(0)
  const overlay = overlayBottomNav && !!bottomNav
  const chrome = useMemo(() => ({ overlay, bottom: overlay ? navHeight : 0 }), [overlay, navHeight])
  const { drawerOpen, sheetSwipeHandlers, sheetStyle, sheetClipStyle, sheetFill, sheetCompositing, underlayStyle } =
    drawer
  const insets = useSafeAreaInsets()
  const wideCard = isWide && !!sidebarWide
  const panelVisible = useWidePanelVisible()
  const frameFill = nativeSheetDrawer ? (sheetFill ?? canvas) : canvas
  const flattenSheet = nativeSheetDrawer && (drawerOpen || sheetCompositing)
  const frameOverflow = nativeSheetDrawer && Platform.OS !== 'web' ? 'visible' : 'hidden'
  const safeAreaAppliesTop = safeAreaEdges === undefined || safeAreaEdges.includes('top')
  const safeAreaAppliesBottom = safeAreaEdges === undefined || safeAreaEdges.includes('bottom')
  const fullHeightUnderlayStyle = nativeSheetDrawer
    ? [
        underlayStyle,
        safeAreaAppliesTop ? { top: -insets.top } : undefined,
        safeAreaAppliesBottom ? { bottom: -insets.bottom } : undefined,
      ]
    : underlayStyle
  // `sheetCompositing` stays true through the closing animation, so the sheet
  // is still there to slide out; it unmounts only once the drawer is closed.
  const sheetMounted = !lazySidebarSheet || drawerOpen || sheetCompositing

  return (
    <SafeAreaView
      className={wideCard ? 'flex-1 bg-sidebar' : 'flex-1 bg-background'}
      style={frameFill && nativeSheetDrawer ? { backgroundColor: frameFill } : undefined}
      edges={safeAreaEdges}
    >
      <View className="flex-1 flex-row">
        {isWide ? sidebarWide : null}

        <View
          className={
            wideCard
              ? panelVisible
                ? 'my-1.5 mr-1.5 overflow-hidden rounded-r-xl border-y border-r border-sidebar-border bg-background'
                : 'my-1.5 ml-1.5 mr-1.5 overflow-hidden rounded-xl border border-sidebar-border bg-background'
              : undefined
          }
          style={[
            { flex: 1, overflow: wideCard ? 'hidden' : frameOverflow },
            nativeSheetDrawer && frameFill ? { backgroundColor: frameFill } : undefined,
          ]}
          collapsable={false}
        >
          {nativeSheetDrawer && sheetMounted ? (
            <View
              pointerEvents={drawerOpen ? 'auto' : 'none'}
              accessibilityElementsHidden={!drawerOpen}
              importantForAccessibility={drawerOpen ? 'auto' : 'no-hide-descendants'}
              style={fullHeightUnderlayStyle}
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
                <PhoneChromeOverlayContext.Provider value={chrome}>
                  {header}
                  <View className="flex-1">{children}</View>
                  {overlay ? (
                    <View
                      pointerEvents="box-none"
                      onLayout={(e) => {
                        const next = Math.round(e.nativeEvent.layout.height)
                        setNavHeight((prev) => (prev === next ? prev : next))
                      }}
                      style={{ marginTop: -navHeight, zIndex: 20 }}
                    >
                      {bottomNav}
                    </View>
                  ) : (
                    bottomNav
                  )}
                </PhoneChromeOverlayContext.Provider>
              </View>
            </Animated.View>
          </Animated.View>
        </View>
      </View>

      {!isWide && !nativeSheetDrawer ? sidebarOverlay : null}
    </SafeAreaView>
  )
}
