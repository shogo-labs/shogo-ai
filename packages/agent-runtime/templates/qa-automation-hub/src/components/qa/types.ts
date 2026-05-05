export type TestStatus = 'passed' | 'failed' | 'skipped' | 'flaky'

export interface TestCase {
  name: string
  status: TestStatus
  duration: number
  viewport?: string
  screenshotPath?: string
  error?: string
}

export interface TestRun {
  id: string
  name: string
  timestamp: string
  duration: number
  passed: number
  failed: number
  skipped: number
  total: number
  trigger: 'manual' | 'ci' | 'heartbeat' | 'scheduled'
  cases: TestCase[]
}

export interface CoverageItem {
  feature: string
  happyPath: boolean
  edgeCases: boolean
  errorStates: boolean
  responsive: boolean
  accessibility: boolean
  lastTested?: string
}

export interface Regression {
  id: string
  page: string
  viewport: string
  baselineScreenshot: string
  currentScreenshot: string
  diffPercentage: number
  status: 'new' | 'approved' | 'rejected'
  detectedAt: string
  commitHash?: string
}

export interface CIBuild {
  id: string
  number: number
  branch: string
  status: 'passed' | 'failed' | 'running' | 'cancelled'
  duration: number
  timestamp: string
  failureCategory?: 'regression' | 'flaky' | 'infra' | 'dependency' | 'build'
  failedTests: number
  totalTests: number
}

export interface FlakyTest {
  name: string
  file: string
  flipCount: number
  lastFlip: string
  status: 'active' | 'quarantined' | 'stabilized'
}
