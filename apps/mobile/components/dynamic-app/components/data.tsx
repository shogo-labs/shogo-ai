/**
 * Data Components for Dynamic App (React Native)
 *
 * Components for displaying structured data: metrics, tables, charts.
 * Uses View + Text flex layout for table rendering.
 */

import type { ReactNode } from 'react'
import { View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { Card } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react-native'
import { formatMetricValue, inferTrendDirection, formatCellValue } from '../smart-format'
import { useCardDepth, useCardSurfaceStyle } from './layout'

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
  /** Override the color sentiment: "positive" = green, "negative" = red. By default inferred from direction. */
  trendSentiment?: 'positive' | 'negative' | 'neutral'
  description?: string
  className?: string
}

export function DynMetric({ label, value, unit, trend, trendValue, trendSentiment, description, className }: MetricProps) {
  const { displayValue, displayUnit } = formatMetricValue(value, unit)
  const depth = useCardDepth()
  const { bgClass, borderClass, shadow } = useCardSurfaceStyle(depth)

  const resolvedTrend = trend || inferTrendDirection(trendValue)
  const TrendIcon = resolvedTrend === 'up' ? TrendingUp : resolvedTrend === 'down' ? TrendingDown : Minus

  // Sentiment determines the color: positive = green, negative = red
  // By default: up = positive, down = negative. trendSentiment overrides this.
  const sentiment = trendSentiment || (resolvedTrend === 'up' ? 'positive' : resolvedTrend === 'down' ? 'negative' : 'neutral')

  return (
    <Card variant="outline" className={cn('p-4 gap-2 rounded-xl flex-1', bgClass, borderClass, className)} style={shadow}>
      <View className="flex flex-row items-center justify-between">
        <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
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
// Chart
// ---------------------------------------------------------------------------

import { LineChart, PieChart } from 'react-native-gifted-charts'
import type { lineDataItem, pieDataItem } from 'react-native-gifted-charts'

interface ChartDataPoint {
  label: string
  value: number
  color?: string
}

type ChartType = 'bar' | 'horizontalBar' | 'progress' | 'line' | 'area' | 'pie' | 'donut'

interface ChartProps {
  type?: ChartType
  data?: ChartDataPoint[]
  title?: string
  height?: number
  showLegend?: boolean
  curved?: boolean
  showDataPoints?: boolean
  innerRadius?: number
  colors?: string[]
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

function getColor(d: ChartDataPoint, i: number, palette?: string[]): string {
  const colors = palette ?? DEFAULT_COLORS
  return d.color || colors[i % colors.length]
}

function ChartLegend({ data, palette }: { data: ChartDataPoint[]; palette?: string[] }) {
  return (
    <View className="flex-row flex-wrap gap-x-4 gap-y-1.5 mt-2">
      {data.map((d, i) => (
        <View key={i} className="flex-row items-center gap-1.5">
          <View className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getColor(d, i, palette) }} />
          <Text className="text-[11px] text-muted-foreground">{d.label}</Text>
        </View>
      ))}
    </View>
  )
}

export function DynChart({
  type = 'bar',
  data = [],
  title,
  height = 200,
  showLegend,
  curved = false,
  showDataPoints = true,
  innerRadius = 60,
  colors,
  className,
}: ChartProps) {
  if (data.length === 0) {
    return (
      <View className={cn('flex items-center justify-center', className)} style={{ height }}>
        <Text className="text-sm text-muted-foreground">No chart data</Text>
      </View>
    )
  }

  const max = Math.max(...data.map((d) => d.value), 1)

  // --- Line / Area ---
  if (type === 'line' || type === 'area') {
    const lineData: lineDataItem[] = data.map((d, i) => ({
      value: d.value,
      label: d.label,
      dataPointColor: getColor(d, i, colors),
    }))
    const lineColor = colors?.[0] ?? DEFAULT_COLORS[0]
    const areaGradientStart = lineColor + '40'
    const areaGradientEnd = lineColor + '05'

    return (
      <View className={cn('flex flex-col gap-2', className)}>
        {title && <Text className="text-sm font-medium">{title}</Text>}
        <LineChart
          data={lineData}
          height={height - 40}
          curved={curved}
          areaChart={type === 'area'}
          color={lineColor}
          startFillColor={type === 'area' ? areaGradientStart : undefined}
          endFillColor={type === 'area' ? areaGradientEnd : undefined}
          startOpacity={type === 'area' ? 0.3 : undefined}
          endOpacity={type === 'area' ? 0.01 : undefined}
          dataPointsColor={lineColor}
          hideDataPoints={!showDataPoints}
          thickness={2}
          xAxisLabelTextStyle={{ fontSize: 10, color: '#888' }}
          yAxisTextStyle={{ fontSize: 10, color: '#888' }}
          noOfSections={4}
          hideRules={false}
          rulesColor="#e5e5e5"
          spacing={Math.max(40, (300 / Math.max(data.length - 1, 1)))}
          isAnimated
        />
        {showLegend && <ChartLegend data={data} palette={colors} />}
      </View>
    )
  }

  // --- Pie / Donut ---
  if (type === 'pie' || type === 'donut') {
    const radius = Math.min((height - 20) / 2, 100)
    const pieData: pieDataItem[] = data.map((d, i) => ({
      value: d.value,
      color: getColor(d, i, colors),
      text: d.label,
    }))
    const legendVisible = showLegend !== false

    return (
      <View className={cn('flex flex-col items-center gap-2', className)}>
        {title && <Text className="text-sm font-medium self-start">{title}</Text>}
        <PieChart
          data={pieData}
          radius={radius}
          donut={type === 'donut'}
          innerRadius={type === 'donut' ? Math.min(innerRadius, radius - 10) : undefined}
          isAnimated
        />
        {legendVisible && <ChartLegend data={data} palette={colors} />}
      </View>
    )
  }

  // --- Horizontal Bar (View-based) ---
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
                style={{ width: `${(d.value / max) * 100}%`, backgroundColor: getColor(d, i, colors) }}
              />
            </View>
            <Text className="text-xs font-medium w-14 text-right">{formatCompactNumber(d.value)}</Text>
          </View>
        ))}
      </View>
    )
  }

  // --- Progress (View-based) ---
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
                style={{ width: `${Math.min(d.value, 100)}%`, backgroundColor: getColor(d, i, colors) }}
              />
            </View>
          </View>
        ))}
      </View>
    )
  }

  // --- Default: Vertical Bar (View-based) ---
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
                style={{ height: barH, backgroundColor: getColor(d, i, colors) }}
              />
              <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>{d.label}</Text>
            </View>
          )
        })}
      </View>
      {showLegend && <ChartLegend data={data} palette={colors} />}
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
