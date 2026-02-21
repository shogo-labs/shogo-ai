/**
 * Data Components for Dynamic App
 *
 * Components for displaying structured data: metrics, tables, charts.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

// ---------------------------------------------------------------------------
// Metric
// ---------------------------------------------------------------------------

interface MetricProps {
  label?: string
  value?: string | number
  unit?: string
  trend?: 'up' | 'down' | 'neutral'
  trendValue?: string
  description?: string
  className?: string
}

export function DynMetric({ label, value, unit, trend, trendValue, description, className }: MetricProps) {
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus

  return (
    <Card className={cn(className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold">{value}{unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}</span>
          {trend && (
            <span className={cn(
              'flex items-center gap-0.5 text-xs font-medium',
              trend === 'up' && 'text-emerald-600',
              trend === 'down' && 'text-red-600',
              trend === 'neutral' && 'text-muted-foreground',
            )}>
              <TrendIcon className="size-3" />
              {trendValue}
            </span>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface TableColumn {
  key: string
  label: string
  align?: 'left' | 'center' | 'right'
  width?: string
}

interface TableProps {
  columns?: TableColumn[]
  rows?: Record<string, unknown>[]
  striped?: boolean
  compact?: boolean
  className?: string
}

export function DynTable({ columns = [], rows = [], striped, compact, className }: TableProps) {
  return (
    <div className={cn('w-full overflow-auto rounded-md border', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'font-medium text-muted-foreground',
                  compact ? 'px-3 py-1.5' : 'px-4 py-3',
                  col.align === 'center' && 'text-center',
                  col.align === 'right' && 'text-right',
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'border-b last:border-0',
                striped && i % 2 === 1 && 'bg-muted/30',
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    compact ? 'px-3 py-1.5' : 'px-4 py-3',
                    col.align === 'center' && 'text-center',
                    col.align === 'right' && 'text-right',
                  )}
                >
                  {String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-muted-foreground">
                No data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart (simple bar/line/pie using CSS — no external library dependency)
// ---------------------------------------------------------------------------

interface ChartDataPoint {
  label: string
  value: number
  color?: string
}

interface ChartProps {
  type?: 'bar' | 'horizontalBar' | 'progress'
  data?: ChartDataPoint[]
  title?: string
  height?: number
  className?: string
}

export function DynChart({ type = 'bar', data = [], title, height = 200, className }: ChartProps) {
  if (data.length === 0) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground border rounded-md', className)} style={{ height }}>
        No chart data
      </div>
    )
  }

  const max = Math.max(...data.map((d) => d.value), 1)

  if (type === 'horizontalBar') {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {title && <p className="text-sm font-medium">{title}</p>}
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20 truncate">{d.label}</span>
            <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${(d.value / max) * 100}%`,
                  backgroundColor: d.color || 'hsl(var(--primary))',
                }}
              />
            </div>
            <span className="text-xs font-medium w-12 text-right">{d.value}</span>
          </div>
        ))}
      </div>
    )
  }

  if (type === 'progress') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {title && <p className="text-sm font-medium">{title}</p>}
        {data.map((d, i) => (
          <div key={i} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span>{d.label}</span>
              <span className="text-muted-foreground">{d.value}%</span>
            </div>
            <div className="bg-muted rounded-full h-2 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(d.value, 100)}%`,
                  backgroundColor: d.color || 'hsl(var(--primary))',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Default: vertical bar chart
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {title && <p className="text-sm font-medium">{title}</p>}
      <div className="flex items-end gap-1" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] font-medium">{d.value}</span>
            <div
              className="w-full rounded-t transition-all"
              style={{
                height: `${(d.value / max) * (height - 30)}px`,
                backgroundColor: d.color || 'hsl(var(--primary))',
                minHeight: 2,
              }}
            />
            <span className="text-[10px] text-muted-foreground truncate max-w-full">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataList (renders children for each item in a data array)
// ---------------------------------------------------------------------------

interface DataListProps {
  children?: ReactNode
  emptyText?: string
  className?: string
}

export function DynDataList({ children, emptyText = 'No items', className }: DataListProps) {
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-muted-foreground text-sm', className)}>
        {emptyText}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {children}
    </div>
  )
}
