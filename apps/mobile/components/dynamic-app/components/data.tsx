/**
 * Data Components for Dynamic App (React Native)
 *
 * Components for displaying structured data: metrics, tables, charts.
 * Uses View + Text flex layout for table rendering.
 */

import type { ReactNode } from 'react'
import { View, Platform } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { Card } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react-native'
import { formatMetricValue, inferTrendDirection, formatCellValue } from '../smart-format'

const CARD_SHADOW_STYLE = Platform.OS === 'web'
  ? { boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)' } as any
  : {}

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
  const { displayValue, displayUnit } = formatMetricValue(value, unit)

  const resolvedTrend = trend || inferTrendDirection(trendValue)
  const TrendIcon = resolvedTrend === 'up' ? TrendingUp : resolvedTrend === 'down' ? TrendingDown : Minus

  return (
    <Card variant="outline" className={cn('p-4 gap-2 rounded-xl bg-card border-border flex-1', className)} style={CARD_SHADOW_STYLE}>
      <View className="flex flex-row items-center justify-between">
        <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
        {resolvedTrend && (
          <TrendIcon
            size={16}
            className={cn(
              'text-muted-foreground',
              resolvedTrend === 'up' && 'text-emerald-500',
              resolvedTrend === 'down' && 'text-red-500',
            )}
          />
        )}
      </View>
      <View>
        <View className="flex flex-row items-baseline">
          <Text className="text-2xl font-bold">{displayValue}</Text>
          {displayUnit ? <Text className="text-sm font-normal text-muted-foreground ml-1">{displayUnit}</Text> : null}
        </View>
        {(trendValue || description) ? (
          <Text className="text-xs text-muted-foreground">
            {[trendValue, description].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Table — View + Text flex layout
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

function getAlignClass(align?: string) {
  if (align === 'center') return 'items-center'
  if (align === 'right') return 'items-end'
  return 'items-start'
}

export function DynTable({ columns = [], rows = [], striped, compact, className }: TableProps) {
  return (
    <View className={cn('w-full', className)}>
      {/* Header */}
      <View className="flex-row border-b border-border">
        {columns.map((col) => (
          <View
            key={col.key}
            className={cn(
              'flex-1',
              compact ? 'px-2 py-2' : 'px-4 py-2.5',
              getAlignClass(col.align),
            )}
          >
            <Text className="text-sm font-medium text-muted-foreground">{col.label}</Text>
          </View>
        ))}
      </View>
      {/* Rows */}
      {rows.map((row, i) => (
        <View
          key={i}
          className={cn(
            'flex-row border-b border-border',
            striped && i % 2 === 1 && 'bg-muted/50',
          )}
        >
          {columns.map((col, colIdx) => (
            <View
              key={col.key}
              className={cn(
                'flex-1',
                compact ? 'px-2 py-2' : 'px-4 py-3',
                getAlignClass(col.align),
              )}
            >
              <Text className={cn('text-sm', colIdx === 0 && 'font-medium')}>
                {formatCellValue(row[col.key])}
              </Text>
            </View>
          ))}
        </View>
      ))}
      {rows.length === 0 && (
        <View className="py-8 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No data</Text>
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Chart — lightweight bars using Views
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
  '#e76e50',
  '#2a9d90',
  '#274754',
  '#e9c46a',
  '#f4a261',
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
      <View className={cn('flex items-center justify-center', className)} style={{ height }}>
        <Text className="text-sm text-muted-foreground">No chart data</Text>
      </View>
    )
  }

  const max = Math.max(...data.map((d) => d.value), 1)

  if (type === 'horizontalBar') {
    return (
      <View className={cn('flex flex-col gap-3', className)}>
        {title && <Text className="text-sm font-medium">{title}</Text>}
        {data.map((d, i) => (
          <View key={i} className="flex-row items-center gap-3">
            <Text className="text-xs text-muted-foreground w-24 text-right" numberOfLines={1}>{d.label}</Text>
            <View className="flex-1 bg-muted/50 rounded-md h-6 overflow-hidden">
              <View
                className="h-full rounded-md"
                style={{ width: `${(d.value / max) * 100}%`, backgroundColor: getColor(d, i) }}
              />
            </View>
            <Text className="text-xs font-medium w-14 text-right">{formatCompactNumber(d.value)}</Text>
          </View>
        ))}
      </View>
    )
  }

  if (type === 'progress') {
    return (
      <View className={cn('flex flex-col gap-3', className)}>
        {title && <Text className="text-sm font-medium">{title}</Text>}
        {data.map((d, i) => (
          <View key={i} className="gap-1.5">
            <View className="flex-row justify-between">
              <Text className="text-xs font-medium">{d.label}</Text>
              <Text className="text-xs text-muted-foreground">{d.value}%</Text>
            </View>
            <View className="bg-muted rounded-full h-2 overflow-hidden">
              <View
                className="h-full rounded-full"
                style={{ width: `${Math.min(d.value, 100)}%`, backgroundColor: getColor(d, i) }}
              />
            </View>
          </View>
        ))}
      </View>
    )
  }

  // Default: vertical bar chart
  const barAreaH = height - 40
  return (
    <View className={cn('flex flex-col gap-2', className)}>
      {title && <Text className="text-sm font-medium">{title}</Text>}
      <View className="flex-row items-end gap-2" style={{ height }}>
        {data.map((d, i) => {
          const barH = Math.max((d.value / max) * barAreaH, 4)
          return (
            <View key={i} className="flex-1 flex-col items-center gap-1">
              <Text className="text-[10px] font-medium text-muted-foreground">
                {formatCompactNumber(d.value)}
              </Text>
              <View
                className="w-full rounded-md"
                style={{ height: barH, backgroundColor: getColor(d, i) }}
              />
              <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>{d.label}</Text>
            </View>
          )
        })}
      </View>
    </View>
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
      <View className={cn('flex items-center justify-center py-8', className)}>
        <Text className="text-muted-foreground text-sm">{emptyText}</Text>
      </View>
    )
  }

  return (
    <View className={cn('flex flex-col gap-2', className)}>
      {children}
    </View>
  )
}
