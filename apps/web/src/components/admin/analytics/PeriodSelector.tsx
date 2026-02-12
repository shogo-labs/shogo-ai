/**
 * PeriodSelector - Toggle between time periods for analytics views.
 */

import { cn } from '@/lib/utils'

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '1y'

const periodLabels: Record<AnalyticsPeriod, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
}

interface PeriodSelectorProps {
  value: AnalyticsPeriod
  onChange: (period: AnalyticsPeriod) => void
}

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <div className="inline-flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {(Object.keys(periodLabels) as AnalyticsPeriod[]).map((period) => (
        <button
          key={period}
          onClick={() => onChange(period)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
            value === period
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {periodLabels[period]}
        </button>
      ))}
    </div>
  )
}
