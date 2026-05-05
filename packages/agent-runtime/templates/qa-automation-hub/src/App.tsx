import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ThemeProvider, useTheme } from './components/ThemeProvider'
import { PassRateMetric } from './components/qa/PassRateMetric'
import { TestRunList } from './components/qa/TestRunList'
import { CoverageMatrix } from './components/qa/CoverageMatrix'
import { RegressionCard } from './components/qa/RegressionCard'
import { CIHealthPanel } from './components/qa/CIHealthPanel'
import type { TestRun, CoverageItem, Regression, CIBuild, FlakyTest } from './components/qa/types'

// --- Agent-managed data arrays ---
// The QA agent populates these as tests run, CI builds complete, and regressions are detected.

const testRuns: TestRun[] = []

const coverageItems: CoverageItem[] = []

const regressions: Regression[] = []

const ciBuilds: CIBuild[] = []

const flakyTests: FlakyTest[] = []

// --- End agent-managed data ---

function totalPassed(runs: TestRun[]) {
  return runs.reduce((sum, r) => sum + r.passed, 0)
}

function totalTests(runs: TestRun[]) {
  return runs.reduce((sum, r) => sum + r.total, 0)
}

function passTrend(runs: TestRun[]): 'up' | 'down' | 'stable' {
  if (runs.length < 2) return 'stable'
  const recent = runs[0]
  const previous = runs[1]
  const recentRate = recent.total > 0 ? recent.passed / recent.total : 0
  const previousRate = previous.total > 0 ? previous.passed / previous.total : 0
  if (recentRate > previousRate) return 'up'
  if (recentRate < previousRate) return 'down'
  return 'stable'
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button
      onClick={toggle}
      className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
    >
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  )
}

function Dashboard() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">🧪</span>
            <h1 className="text-3xl font-semibold tracking-tight">QA Automation Hub</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            E2E test plans, Playwright scripts, visual regression baselines, and CI failure triage — all in one place.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className="mb-6">
        <PassRateMetric
          passed={totalPassed(testRuns)}
          total={totalTests(testRuns)}
          trend={passTrend(testRuns)}
        />
      </div>

      <Tabs defaultValue="test_runs">
        <TabsList>
          <TabsTrigger value="test_runs">Test Runs</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="regressions">Regressions</TabsTrigger>
          <TabsTrigger value="ci_health">CI Health</TabsTrigger>
        </TabsList>

        <TabsContent value="test_runs">
          <TestRunList runs={testRuns} />
        </TabsContent>

        <TabsContent value="coverage">
          <CoverageMatrix items={coverageItems} />
        </TabsContent>

        <TabsContent value="regressions">
          {regressions.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
              <p className="text-lg font-medium text-muted-foreground">No visual regressions</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Run visual regression tests to capture baselines and detect changes.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {regressions.map((r) => (
                <RegressionCard key={r.id} regression={r} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="ci_health">
          <CIHealthPanel builds={ciBuilds} flakyTests={flakyTests} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <Dashboard />
    </ThemeProvider>
  )
}
