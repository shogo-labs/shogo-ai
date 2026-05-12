import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { CIBuild, FlakyTest } from './types'

interface CIHealthPanelProps {
  builds: CIBuild[]
  flakyTests: FlakyTest[]
}

function BuildRow({ build }: { build: CIBuild }) {
  const statusColor =
    build.status === 'passed'
      ? 'text-emerald-500'
      : build.status === 'failed'
        ? 'text-red-500'
        : build.status === 'running'
          ? 'text-blue-500'
          : 'text-zinc-400'

  const statusIcon =
    build.status === 'passed'
      ? '✓'
      : build.status === 'failed'
        ? '✗'
        : build.status === 'running'
          ? '●'
          : '⊘'

  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <span className={statusColor}>{statusIcon}</span>
        <span className="font-medium">#{build.number}</span>
        <span className="text-muted-foreground">{build.branch}</span>
      </div>
      <div className="flex items-center gap-3">
        {build.failureCategory && (
          <Badge variant="secondary" className="text-xs">
            {build.failureCategory}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {build.failedTests}/{build.totalTests} failed
        </span>
        <span className="text-xs text-muted-foreground">
          {(build.duration / 1000).toFixed(0)}s
        </span>
      </div>
    </div>
  )
}

function FlakyTestRow({ test }: { test: FlakyTest }) {
  const statusVariant =
    test.status === 'active'
      ? 'destructive'
      : test.status === 'quarantined'
        ? 'secondary'
        : 'default'

  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{test.name}</p>
        <p className="truncate text-xs text-muted-foreground">{test.file}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {test.flipCount} flips
        </span>
        <Badge variant={statusVariant} className="text-xs">
          {test.status}
        </Badge>
      </div>
    </div>
  )
}

export function CIHealthPanel({ builds, flakyTests }: CIHealthPanelProps) {
  const hasBuilds = builds.length > 0
  const hasFlakyTests = flakyTests.length > 0

  if (!hasBuilds && !hasFlakyTests) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
        <p className="text-lg font-medium text-muted-foreground">No CI data</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your CI provider to monitor build health.
        </p>
      </div>
    )
  }

  const passedBuilds = builds.filter((b) => b.status === 'passed').length
  const buildPassRate = builds.length > 0 ? Math.round((passedBuilds / builds.length) * 100) : 0

  return (
    <div className="space-y-6">
      {hasBuilds && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent Builds</CardTitle>
              <span className="text-sm text-muted-foreground">
                {buildPassRate}% pass rate ({passedBuilds}/{builds.length})
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {builds.map((build) => (
              <BuildRow key={build.id} build={build} />
            ))}
          </CardContent>
        </Card>
      )}

      {hasFlakyTests && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Flaky Test Leaderboard</CardTitle>
              <span className="text-sm text-muted-foreground">
                {flakyTests.filter((t) => t.status === 'active').length} active
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {flakyTests
              .sort((a, b) => b.flipCount - a.flipCount)
              .map((test, i) => (
                <FlakyTestRow key={i} test={test} />
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
