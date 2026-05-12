import type { TestRun } from './types'
import { TestRunCard } from './TestRunCard'

interface TestRunListProps {
  runs: TestRun[]
}

export function TestRunList({ runs }: TestRunListProps) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
        <p className="text-lg font-medium text-muted-foreground">No test runs yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the agent to run tests or connect your CI pipeline.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {runs.map((run) => (
        <TestRunCard key={run.id} run={run} />
      ))}
    </div>
  )
}
