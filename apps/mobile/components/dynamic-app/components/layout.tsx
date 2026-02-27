/**
 * Layout Components for Dynamic App (React Native)
 *
 * Wrappers around flexbox layout primitives, accepting
 * resolved props from the renderer engine.
 */

import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
import { View, ScrollView, Platform } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { Card } from '@/components/ui/card'

// ---------------------------------------------------------------------------
// Card Depth Context — tracks nesting level for visual hierarchy
// ---------------------------------------------------------------------------

const CardDepthContext = createContext(0)
export const useCardDepth = () => useContext(CardDepthContext)

// M3-inspired surface container classes: each depth progressively tints.
// Colors defined in global.css as --color-surface-{0..3} and auto-switch
// between light/dark via the .dark class — no JS theme detection needed.
const SURFACE_BG = ['bg-surface-0', 'bg-surface-1', 'bg-surface-2', 'bg-surface-3']
const SURFACE_BORDER = ['border-border', 'border-border', 'border-border', 'border-border']

// Shadow diminishes with depth — nested cards feel visually "inset".
const SHADOW_STYLES = [
  Platform.OS === 'web' ? { boxShadow: '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.08)' } as any : {},
  Platform.OS === 'web' ? { boxShadow: '0 1px 2px 0 rgba(0,0,0,0.04)' } as any : {},
]

export function useCardSurfaceStyle(depth: number) {
  return useMemo(() => {
    const level = Math.min(depth, SURFACE_BG.length - 1)
    const bgClass = SURFACE_BG[level]
    const borderClass = SURFACE_BORDER[level]
    const shadow = level < SHADOW_STYLES.length ? SHADOW_STYLES[level] : {}
    return { bgClass, borderClass, shadow }
  }, [depth])
}

const GAP_MAP: Record<string, string> = {
  none: 'gap-0',
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
  xl: 'gap-8',
}

const ALIGN_MAP: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
}

const JUSTIFY_MAP: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
  evenly: 'justify-evenly',
}

interface LayoutProps {
  children?: ReactNode
  gap?: string
  align?: string
  justify?: string
  wrap?: boolean
  padding?: string
  className?: string
}

export function DynRow({ children, gap = 'md', align, justify, wrap, padding, className }: LayoutProps) {
  return (
    <View
      className={cn(
        'flex flex-row',
        GAP_MAP[gap] || 'gap-4',
        align && ALIGN_MAP[align],
        justify && JUSTIFY_MAP[justify],
        wrap && 'flex-wrap',
        padding && `p-${padding}`,
        className,
      )}
    >
      {children}
    </View>
  )
}

export function DynColumn({ children, gap = 'md', align, justify, padding, className }: LayoutProps) {
  return (
    <View
      className={cn(
        'flex flex-col',
        GAP_MAP[gap] || 'gap-4',
        align && ALIGN_MAP[align],
        justify && JUSTIFY_MAP[justify],
        padding && `p-${padding}`,
        className,
      )}
    >
      {children}
    </View>
  )
}

interface GridProps {
  children?: ReactNode
  columns?: number | string
  gap?: string
  className?: string
}

const GAP_PX: Record<string, number> = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
}

export function DynGrid({ children, columns = 2, gap = 'md', className }: GridProps) {
  const cols = typeof columns === 'number' ? columns : 2
  const gapPx = GAP_PX[gap] ?? 16
  const totalGap = gapPx * (cols - 1)

  return (
    <View className={cn('flex flex-row flex-wrap items-stretch', GAP_MAP[gap] || 'gap-4', className)}>
      {React.Children.map(children, (child) => (
        <View style={{ width: `calc(${100 / cols}% - ${totalGap / cols}px)` }} className="flex">
          {child}
        </View>
      ))}
    </View>
  )
}

interface CardProps {
  children?: ReactNode
  title?: string
  description?: string
  footer?: string
  className?: string
}

export function DynCard({ children, title, description, footer, className }: CardProps) {
  const depth = useCardDepth()
  const { bgClass, borderClass, shadow } = useCardSurfaceStyle(depth)

  return (
    <CardDepthContext.Provider value={depth + 1}>
      <Card
        variant="outline"
        className={cn('p-0 rounded-xl flex-1', bgClass, borderClass, className)}
        style={shadow}
      >
        {(title || description) && (
          <View className="px-6 pt-6 pb-2">
            {title && <Text className="text-lg font-semibold">{title}</Text>}
            {description && <Text className="text-sm text-muted-foreground">{description}</Text>}
          </View>
        )}
        <View className="px-6 pb-6">{children}</View>
        {footer && (
          <View className="px-6 pb-6 pt-0 border-t border-border/30">
            <Text className="text-sm text-muted-foreground pt-3">{footer}</Text>
          </View>
        )}
      </Card>
    </CardDepthContext.Provider>
  )
}

interface ScrollAreaProps {
  children?: ReactNode
  height?: string | number
  className?: string
}

export function DynScrollArea({ children, height, className }: ScrollAreaProps) {
  const h = height != null
    ? (typeof height === 'number' ? height : parseInt(String(height), 10) || undefined)
    : undefined

  return (
    <ScrollView className={cn(className)} style={h ? { height: h } : { flex: 1 }}>
      {children}
    </ScrollView>
  )
}
