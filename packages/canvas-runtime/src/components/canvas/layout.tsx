import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const CardDepthContext = createContext(0)
export const useCardDepth = () => useContext(CardDepthContext)

const SURFACE_BG = ['bg-surface-0', 'bg-surface-1', 'bg-surface-2', 'bg-surface-3']

export function useCardSurfaceStyle(depth: number) {
  return useMemo(() => {
    const level = Math.min(depth, SURFACE_BG.length - 1)
    return {
      bgClass: SURFACE_BG[level],
      borderClass: 'border-border',
      shadow: level === 0
        ? { boxShadow: '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.08)' }
        : level === 1
          ? { boxShadow: '0 1px 2px 0 rgba(0,0,0,0.04)' }
          : {},
    }
  }, [depth])
}

const GAP_MAP: Record<string, string> = {
  none: 'gap-0', xs: 'gap-1', sm: 'gap-2', md: 'gap-4', lg: 'gap-6', xl: 'gap-8',
}
const ALIGN_MAP: Record<string, string> = {
  start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline',
}
const JUSTIFY_MAP: Record<string, string> = {
  start: 'justify-start', center: 'justify-center', end: 'justify-end',
  between: 'justify-between', around: 'justify-around', evenly: 'justify-evenly',
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

export function Row({ children, gap = 'md', align, justify, wrap, padding, className }: LayoutProps) {
  return (
    <div
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
    </div>
  )
}

export function Column({ children, gap = 'md', align, justify, padding, className }: LayoutProps) {
  return (
    <div
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
    </div>
  )
}

interface GridProps {
  children?: ReactNode
  columns?: number | string
  gap?: string
  className?: string
}

const GAP_PX: Record<string, number> = { none: 0, xs: 4, sm: 8, md: 16, lg: 24, xl: 32 }

export function Grid({ children, columns = 2, gap = 'md', className }: GridProps) {
  const cols = typeof columns === 'number' ? columns : 2
  const gapPx = GAP_PX[gap] ?? 16
  const totalGap = gapPx * (cols - 1)

  return (
    <div className={cn('flex flex-row flex-wrap items-stretch', GAP_MAP[gap] || 'gap-4', className)}>
      {React.Children.map(children, (child) => (
        <div style={{ width: `calc(${100 / cols}% - ${totalGap / cols}px)` }} className="flex">
          {child}
        </div>
      ))}
    </div>
  )
}

interface CanvasCardProps {
  children?: ReactNode
  title?: string
  description?: string
  footer?: string
  className?: string
}

export function CanvasCard({ children, title, description, footer, className }: CanvasCardProps) {
  const depth = useCardDepth()
  const { bgClass, borderClass, shadow } = useCardSurfaceStyle(depth)

  return (
    <CardDepthContext.Provider value={depth + 1}>
      <div
        className={cn('rounded-xl border p-0 flex-1', bgClass, borderClass, className)}
        style={shadow}
      >
        {(title || description) && (
          <div className="px-6 pt-6 pb-2">
            {title && <p className="text-lg font-semibold">{title}</p>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
        )}
        <div className={cn('px-6 pb-6', !(title || description) && 'pt-6')}>{children}</div>
        {footer && (
          <div className="px-6 pb-6 pt-0 border-t border-border/30">
            <p className="text-sm text-muted-foreground pt-3">{footer}</p>
          </div>
        )}
      </div>
    </CardDepthContext.Provider>
  )
}

interface ScrollAreaProps {
  children?: ReactNode
  height?: string | number
  className?: string
}

export function CanvasScrollArea({ children, height, className }: ScrollAreaProps) {
  const h = height != null
    ? (typeof height === 'number' ? height : parseInt(String(height), 10) || undefined)
    : undefined

  return (
    <div className={cn('overflow-auto', className)} style={h ? { height: h } : { flex: 1 }}>
      {children}
    </div>
  )
}
