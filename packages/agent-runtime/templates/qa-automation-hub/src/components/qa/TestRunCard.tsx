import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { TestRun, TestCase } from './types'

function StatusBadge({ status }: { status: TestCase['status'] }) {
  const variant =
    status === 'passed'
      ? 'default'
      : status === 'failed'
        ? 'destructive'
        : 'secondary'
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return <Badge variant={variant}>{label}</Badge>
}

export function TestRunCard({ run }: { run: TestRun }) {
  const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
  const allPassed = run.failed === 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">{run.name}</CardTitle>
          <Badge variant={allPassed ? 'default' : 'destructive'}>
            {allPassed ? 'Passed' : `${run.failed} Failed`}
          </Badge>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{new Date(run.timestamp).toLocaleString()}</span>
          <span>{(run.duration / 1000).toFixed(1)}s</span>
          <span className="capitalize">{run.trigger}</span>
          <span>{passRate}% pass rate</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3 text-sm">
          <span className="text-emerald-500">✓ {run.passed}</span>
          <span className="text-red-500">✗ {run.failed}</span>
          {run.skipped > 0 && (
            <span className="text-zinc-400">⊘ {run.skipped}</span>
          )}
        </div>
        {run.cases.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {run.cases.map((tc, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm"
              >
                <span className="truncate">{tc.name}</span>
                <div className="flex items-center gap-2">
                  {tc.viewport && (
                    <span className="text-xs text-muted-foreground">{tc.viewport}</span>
                  )}
                  <StatusBadge status={tc.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
