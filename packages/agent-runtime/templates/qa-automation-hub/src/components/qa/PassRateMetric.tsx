import { Card, CardContent } from '@/components/ui/card'

interface PassRateMetricProps {
  passed: number
  total: number
  trend?: 'up' | 'down' | 'stable'
}

export function PassRateMetric({ passed, total, trend = 'stable' }: PassRateMetricProps) {
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0
  const color =
    rate >= 95 ? 'text-emerald-500' : rate >= 80 ? 'text-amber-500' : 'text-red-500'

  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  const trendColor =
    trend === 'up'
      ? 'text-emerald-500'
      : trend === 'down'
        ? 'text-red-500'
        : 'text-zinc-400'

  return (
    <Card>
      <CardContent className="flex items-center gap-6 pt-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Overall Pass Rate</p>
          <div className="flex items-baseline gap-2">
            <span className={`text-5xl font-bold tabular-nums ${color}`}>{rate}%</span>
            <span className={`text-lg font-medium ${trendColor}`}>{trendIcon}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {passed} passed / {total} total tests
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
