/**
 * Data Components for Dynamic App
 *
 * Components for displaying structured data: metrics, tables, charts.
 *
 * Follows the official shadcn/ui dashboard patterns:
 * - Metric uses Card with CardHeader/CardContent hierarchy
 * - Table renders a clean <table> (parent wraps in Card when needed)
 * - Chart renders lightweight SVG-free bars (parent wraps in Card when needed)
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompactNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}K`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// ---------------------------------------------------------------------------
// Metric — follows official shadcn dashboard card pattern
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
    <Card className={cn('gap-2', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle className="text-sm font-medium tracking-tight text-muted-foreground">
          {label}
        </CardTitle>
        {trend && <TrendIcon className={cn(
          'size-4 text-muted-foreground',
          trend === 'up' && 'text-emerald-500',
          trend === 'down' && 'text-red-500',
        )} />}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">
          {value}
          {unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
        </div>
        {(trendValue || description) && (
          <p className="text-xs text-muted-foreground">
            {trendValue}{trendValue && description ? ' · ' : ''}{description}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Table — clean table, relies on parent Card for wrapping
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
    <div className={cn('relative w-full overflow-auto', className)}>
      <table className="w-full caption-bottom text-sm">
        <thead className="[&_tr]:border-b">
          <tr className="border-b transition-colors hover:bg-muted/50">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'h-10 text-left align-middle font-medium text-muted-foreground',
                  compact ? 'px-2' : 'px-4',
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
        <tbody className="[&_tr:last-child]:border-0">
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'border-b transition-colors hover:bg-muted/50',
                striped && i % 2 === 1 && 'bg-muted/50',
              )}
            >
              {columns.map((col, colIdx) => (
                <td
                  key={col.key}
                  className={cn(
                    'align-middle',
                    compact ? 'p-2' : 'p-4',
                    colIdx === 0 && 'font-medium',
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
              <td colSpan={columns.length} className="h-24 text-center text-muted-foreground">
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
// Chart — lightweight CSS bars, relies on parent Card for wrapping
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

const DEFAULT_COLORS = [
  'var(--chart-1, #e76e50)',
  'var(--chart-2, #2a9d90)',
  'var(--chart-3, #274754)',
  'var(--chart-4, #e9c46a)',
  'var(--chart-5, #f4a261)',
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
]

function getColor(d: ChartDataPoint, i: number): string {
  return d.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
}

export function DynChart({ type = 'bar', data = [], title, height = 200, className }: ChartProps) {
  if (data.length === 0) {
    return (
      <div className={cn('flex items-center justify-center text-sm text-muted-foreground', className)} style={{ height }}>
        No chart data
      </div>
    )
  }

  const max = Math.max(...data.map((d) => d.value), 1)

  if (type === 'horizontalBar') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {title && <p className="text-sm font-medium">{title}</p>}
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-3 group">
            <span className="text-xs text-muted-foreground w-24 truncate text-right">{d.label}</span>
            <div className="flex-1 bg-muted/50 rounded-md h-6 overflow-hidden">
              <div
                className="h-full rounded-md transition-all duration-300 ease-in-out"
                style={{ width: `${(d.value / max) * 100}%`, backgroundColor: getColor(d, i) }}
              />
            </div>
            <span className="text-xs font-medium tabular-nums w-14 text-right">{formatCompactNumber(d.value)}</span>
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
          <div key={i} className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="font-medium">{d.label}</span>
              <span className="text-muted-foreground tabular-nums">{d.value}%</span>
            </div>
            <div className="bg-muted rounded-full h-2 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.min(d.value, 100)}%`, backgroundColor: getColor(d, i) }}
              />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Default: vertical bar chart
  const barAreaH = height - 40
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {title && <p className="text-sm font-medium">{title}</p>}
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => {
          const barH = Math.max((d.value / max) * barAreaH, 4)
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                {formatCompactNumber(d.value)}
              </span>
              <div
                className="w-full rounded-md transition-all duration-300 ease-in-out group-hover:opacity-80"
                style={{ height: `${barH}px`, backgroundColor: getColor(d, i) }}
              />
              <span className="text-[10px] text-muted-foreground truncate max-w-full">{d.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataList
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
