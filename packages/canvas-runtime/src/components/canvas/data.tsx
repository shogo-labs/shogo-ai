import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useCardDepth, useCardSurfaceStyle } from './layout'

function formatCompactNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}K`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function formatNumberWithCommas(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const parts = n.toString().split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 100_000) return `${Math.round(n / 1_000)}K`
  return formatNumberWithCommas(n)
}

const PURE_NUMBER_RE = /^-?\d+(\.\d+)?$/

function formatMetricValue(value: unknown, unit?: string): { displayValue: string; displayUnit: string } {
  if (value == null) return { displayValue: '—', displayUnit: '' }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (unit === '$') return { displayValue: `$${formatCompact(value)}`, displayUnit: '' }
    if (unit === '%') return { displayValue: `${value}%`, displayUnit: '' }
    return { displayValue: formatCompact(value), displayUnit: unit || '' }
  }
  const str = String(value)
  if (PURE_NUMBER_RE.test(str)) {
    const numVal = parseFloat(str)
    if (unit === '$') return { displayValue: `$${formatCompact(numVal)}`, displayUnit: '' }
    if (unit === '%') return { displayValue: `${numVal}%`, displayUnit: '' }
    return { displayValue: formatCompact(numVal), displayUnit: unit || '' }
  }
  return { displayValue: str, displayUnit: unit || '' }
}

function inferTrendDirection(trendValue?: string): 'up' | 'down' | 'neutral' | undefined {
  if (!trendValue) return undefined
  const trimmed = trendValue.trim()
  if (trimmed.startsWith('+')) return 'up'
  if (trimmed.startsWith('-')) return 'down'
  if (/^[\d$]/.test(trimmed)) return 'up'
  return undefined
}

function formatCellValue(val: unknown): string {
  if (val == null) return '—'
  if (typeof val === 'number' && Number.isFinite(val)) return formatNumberWithCommas(val)
  return String(val)
}

interface MetricProps {
  label?: string
  value?: string | number
  unit?: string
  trend?: 'up' | 'down' | 'neutral'
  trendValue?: string
  trendSentiment?: 'positive' | 'negative' | 'neutral'
  description?: string
  className?: string
}

export function Metric({ label, value, unit, trend, trendValue, trendSentiment, description, className }: MetricProps) {
  const { displayValue, displayUnit } = formatMetricValue(value, unit)
  const depth = useCardDepth()
  const { bgClass, borderClass, shadow } = useCardSurfaceStyle(depth)

  const resolvedTrend = trend || inferTrendDirection(trendValue)
  const TrendIcon = resolvedTrend === 'up' ? TrendingUp : resolvedTrend === 'down' ? TrendingDown : Minus
  const sentiment = trendSentiment || (resolvedTrend === 'up' ? 'positive' : resolvedTrend === 'down' ? 'negative' : 'neutral')

  return (
    <div className={cn('border rounded-xl p-4 gap-2 flex-1 flex flex-col', bgClass, borderClass, className)} style={shadow}>
      <div className="flex flex-row items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {resolvedTrend && (
          <TrendIcon
            size={16}
            className={cn(
              'text-muted-foreground',
              sentiment === 'positive' && 'text-emerald-500',
              sentiment === 'negative' && 'text-red-500',
            )}
          />
        )}
      </div>
      <div>
        <div className="flex flex-row items-baseline">
          <span className="text-2xl font-bold">{displayValue}</span>
          {displayUnit ? <span className="text-sm font-normal text-muted-foreground ml-1">{displayUnit}</span> : null}
        </div>
        {(trendValue || description) ? (
          <span className="text-xs text-muted-foreground">
            {[trendValue, description].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

interface TableColumn {
  key: string
  label: string
  align?: 'left' | 'center' | 'right'
}

interface DynTableProps {
  columns?: TableColumn[]
  rows?: Record<string, unknown>[]
  striped?: boolean
  compact?: boolean
  className?: string
}

function getAlignClass(align?: string) {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

export function DynTable({ columns = [], rows = [], striped, compact, className }: DynTableProps) {
  return (
    <div className={cn('w-full', className)}>
      <div className="flex border-b border-border">
        {columns.map((col) => (
          <div
            key={col.key}
            className={cn('flex-1', compact ? 'px-2 py-2' : 'px-4 py-2.5', getAlignClass(col.align))}
          >
            <span className="text-sm font-medium text-muted-foreground">{col.label}</span>
          </div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} className={cn('flex border-b border-border', striped && i % 2 === 1 && 'bg-muted/50')}>
          {columns.map((col, colIdx) => (
            <div key={col.key} className={cn('flex-1', compact ? 'px-2 py-2' : 'px-4 py-3', getAlignClass(col.align))}>
              <span className={cn('text-sm', colIdx === 0 && 'font-medium')}>
                {formatCellValue(row[col.key])}
              </span>
            </div>
          ))}
        </div>
      ))}
      {rows.length === 0 && (
        <div className="py-8 flex items-center justify-center">
          <span className="text-sm text-muted-foreground">No data</span>
        </div>
      )}
    </div>
  )
}

interface ChartDataPoint {
  label: string
  value: number
  color?: string
}

type ChartType = 'bar' | 'horizontalBar' | 'progress' | 'line' | 'area' | 'pie' | 'donut'

interface DynChartProps {
  type?: ChartType
  data?: ChartDataPoint[]
  title?: string
  height?: number
  showLegend?: boolean
  colors?: string[]
  className?: string
}

const DEFAULT_COLORS = ['#e76e50', '#2a9d90', '#274754', '#e9c46a', '#f4a261', '#3b82f6', '#8b5cf6', '#10b981']

function getColor(d: ChartDataPoint, i: number, palette?: string[]): string {
  return d.color || (palette ?? DEFAULT_COLORS)[i % (palette ?? DEFAULT_COLORS).length]
}

export function DynChart({ type = 'bar', data: rawData, title, height = 200, showLegend, colors, className }: DynChartProps) {
  const data = (Array.isArray(rawData) ? rawData : []).filter(
    (d): d is ChartDataPoint => d != null && typeof d.value === 'number',
  )
  if (data.length === 0) {
    return (
      <div className={cn('flex items-center justify-center', className)} style={{ height }}>
        <span className="text-sm text-muted-foreground">No chart data</span>
      </div>
    )
  }

  const max = Math.max(...data.map((d) => d.value), 1)

  if (type === 'horizontalBar') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {title && <span className="text-sm font-medium">{title}</span>}
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-24 text-right truncate">{d.label}</span>
            <div className="flex-1 bg-muted/50 rounded-md h-6 overflow-hidden">
              <div className="h-full rounded-md" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: getColor(d, i, colors) }} />
            </div>
            <span className="text-xs font-medium w-14 text-right">{formatCompactNumber(d.value)}</span>
          </div>
        ))}
      </div>
    )
  }

  if (type === 'progress') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {title && <span className="text-sm font-medium">{title}</span>}
        {data.map((d, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <span className="text-xs font-medium">{d.label}</span>
              <span className="text-xs text-muted-foreground">{d.value}%</span>
            </div>
            <div className="bg-muted rounded-full h-2 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.min(d.value, 100)}%`, backgroundColor: getColor(d, i, colors) }} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (type === 'pie' || type === 'donut') {
    const total = data.reduce((sum, d) => sum + d.value, 0)
    return (
      <div className={cn('flex flex-col items-center gap-2', className)}>
        {title && <span className="text-sm font-medium self-start">{title}</span>}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {data.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getColor(d, i, colors) }} />
              <span className="text-xs text-muted-foreground">{d.label} ({total > 0 ? Math.round((d.value / total) * 100) : 0}%)</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const barAreaH = height - 40
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {title && <span className="text-sm font-medium">{title}</span>}
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => {
          const barH = Math.max((d.value / max) * barAreaH, 4)
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">{formatCompactNumber(d.value)}</span>
              <div className="w-full rounded-md" style={{ height: barH, backgroundColor: getColor(d, i, colors) }} />
              <span className="text-[10px] text-muted-foreground truncate w-full text-center">{d.label}</span>
            </div>
          )
        })}
      </div>
      {showLegend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2">
          {data.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getColor(d, i, colors) }} />
              <span className="text-[11px] text-muted-foreground">{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface DataListProps {
  children?: ReactNode
  emptyText?: string
  className?: string
}

export function DataList({ children, emptyText = 'No items', className }: DataListProps) {
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return (
      <div className={cn('flex items-center justify-center py-8', className)}>
        <span className="text-muted-foreground text-sm">{emptyText}</span>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {children}
    </div>
  )
}
