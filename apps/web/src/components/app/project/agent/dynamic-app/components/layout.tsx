/**
 * Layout Components for Dynamic App
 *
 * Wrappers around flexbox/grid/shadcn layout primitives, accepting
 * resolved props from the renderer engine.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'

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

export function DynColumn({ children, gap = 'md', align, justify, padding, className }: LayoutProps) {
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

export function DynGrid({ children, columns = 2, gap = 'md', className }: GridProps) {
  const colClass = typeof columns === 'number'
    ? `grid-cols-${columns}`
    : columns

  return (
    <div
      className={cn('grid', colClass, GAP_MAP[gap] || 'gap-4', className)}
      style={typeof columns === 'number' && columns > 6 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {children}
    </div>
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
  return (
    <Card className={cn(className)}>
      {(title || description) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
      {footer && <CardFooter><span className="text-sm text-muted-foreground">{footer}</span></CardFooter>}
    </Card>
  )
}

interface ScrollAreaProps {
  children?: ReactNode
  height?: string | number
  className?: string
}

export function DynScrollArea({ children, height = '400px', className }: ScrollAreaProps) {
  return (
    <ScrollArea className={cn(className)} style={{ height: typeof height === 'number' ? `${height}px` : height }}>
      {children}
    </ScrollArea>
  )
}
