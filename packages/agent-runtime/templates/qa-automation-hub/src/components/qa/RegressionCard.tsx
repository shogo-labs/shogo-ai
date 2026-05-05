import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Regression } from './types'

interface RegressionCardProps {
  regression: Regression
}

export function RegressionCard({ regression }: RegressionCardProps) {
  const severityColor =
    regression.diffPercentage > 5
      ? 'text-red-500'
      : regression.diffPercentage > 1
        ? 'text-amber-500'
        : 'text-yellow-500'

  const statusVariant =
    regression.status === 'approved'
      ? 'default'
      : regression.status === 'rejected'
        ? 'destructive'
        : 'secondary'

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">
            {regression.page}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              @ {regression.viewport}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold tabular-nums ${severityColor}`}>
              {regression.diffPercentage.toFixed(2)}% diff
            </span>
            <Badge variant={statusVariant}>
              {regression.status.charAt(0).toUpperCase() + regression.status.slice(1)}
            </Badge>
          </div>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Detected {new Date(regression.detectedAt).toLocaleDateString()}</span>
          {regression.commitHash && <span>Commit {regression.commitHash.slice(0, 7)}</span>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="overflow-hidden rounded-md border border-border">
            <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Baseline
            </div>
            <div className="flex h-40 items-center justify-center bg-zinc-900/50 text-xs text-muted-foreground">
              {regression.baselineScreenshot ? (
                <img
                  src={regression.baselineScreenshot}
                  alt="Baseline"
                  className="h-full w-full object-cover"
                />
              ) : (
                'Screenshot pending'
              )}
            </div>
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Current
            </div>
            <div className="flex h-40 items-center justify-center bg-zinc-900/50 text-xs text-muted-foreground">
              {regression.currentScreenshot ? (
                <img
                  src={regression.currentScreenshot}
                  alt="Current"
                  className="h-full w-full object-cover"
                />
              ) : (
                'Screenshot pending'
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
