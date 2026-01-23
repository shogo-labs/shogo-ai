/**
 * TestPanel - E2E test runner for project workspace
 *
 * Provides a full-featured UI for running Playwright tests:
 * - Test file tree sidebar (Option B)
 * - Run all tests or specific files/tests
 * - Run tests in headed mode (visible browser)
 * - Streaming test output with pass/fail highlighting
 * - Test summary (passed/failed counts)
 * - Trace viewer for replaying test execution
 *
 * Uses the tests API for file discovery and the terminal exec API
 * for backwards compatibility with preset commands.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import {
  Play,
  Loader2,
  TestTube,
  Trash2,
  CheckCircle2,
  XCircle,
  Eye,
  RotateCcw,
  Clock,
  FileCode,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  RefreshCw,
  Film,
  Download,
  ExternalLink,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Test file from API
 */
interface TestFile {
  path: string
  name: string
  tests: TestCase[]
}

/**
 * Individual test case
 */
interface TestCase {
  title: string
  line?: number
  fullTitle: string
}

/**
 * Test execution state
 */
interface TestExecution {
  commandId: string
  label: string
  startTime: number
  output: string
  status: 'running' | 'success' | 'error' | 'idle'
  exitCode?: number
  file?: string
  testName?: string
}

/**
 * Parsed test results from output
 */
interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
  duration?: string
}

/**
 * Trace file info from API
 */
interface TraceFile {
  name: string
  path: string
  size: number
  modified: string
}

export interface TestPanelProps {
  /** Project ID to run tests for */
  projectId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Parse test summary from Playwright output
 * Looks for patterns like "2 passed" or "1 failed"
 */
function parseTestSummary(output: string): TestSummary | null {
  // Playwright outputs: "X passed", "X failed", "X skipped"
  const passedMatch = output.match(/(\d+)\s+passed/)
  const failedMatch = output.match(/(\d+)\s+failed/)
  const skippedMatch = output.match(/(\d+)\s+skipped/)
  const durationMatch = output.match(/\((\d+(?:\.\d+)?[ms]+)\)/)
  
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0
  const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0
  
  if (passed === 0 && failed === 0 && skipped === 0) {
    return null
  }
  
  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration: durationMatch ? durationMatch[1] : undefined,
  }
}

/**
 * Get relative time string (e.g., "2m ago", "1h ago")
 */
function getTimeAgo(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

/**
 * Add ANSI color highlighting for test output
 * Highlights pass/fail indicators
 */
function highlightOutput(output: string): React.ReactNode[] {
  const lines = output.split('\n')
  
  return lines.map((line, i) => {
    // Highlight passed tests (green checkmark or "passed")
    if (line.includes('✓') || line.includes('passed') || line.match(/^\s*✔/)) {
      return (
        <span key={i} className="text-green-400">
          {line}
          {'\n'}
        </span>
      )
    }
    
    // Highlight failed tests (red x or "failed")
    if (line.includes('✗') || line.includes('failed') || line.includes('Error:') || line.match(/^\s*✘/)) {
      return (
        <span key={i} className="text-red-400">
          {line}
          {'\n'}
        </span>
      )
    }
    
    // Highlight skipped tests (yellow)
    if (line.includes('skipped') || line.includes('⊘')) {
      return (
        <span key={i} className="text-yellow-400">
          {line}
          {'\n'}
        </span>
      )
    }
    
    // Highlight test file names
    if (line.match(/^\s*[▶►]\s+/) || line.match(/\.test\.(ts|js|tsx|jsx)/)) {
      return (
        <span key={i} className="text-blue-300">
          {line}
          {'\n'}
        </span>
      )
    }
    
    // Default
    return (
      <span key={i}>
        {line}
        {'\n'}
      </span>
    )
  })
}

export function TestPanel({
  projectId,
  className,
}: TestPanelProps) {
  // Test files state
  const [testFiles, setTestFiles] = useState<TestFile[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(true)
  
  // Execution state
  const [execution, setExecution] = useState<TestExecution>({
    commandId: '',
    label: '',
    startTime: 0,
    output: '',
    status: 'idle',
  })
  const [history, setHistory] = useState<TestExecution[]>([])
  
  // Trace viewer state
  const [traces, setTraces] = useState<TraceFile[]>([])
  const [isLoadingTraces, setIsLoadingTraces] = useState(false)
  const [activeTrace, setActiveTrace] = useState<TraceFile | null>(null)
  const [showTraceViewer, setShowTraceViewer] = useState(false)
  const [traceViewerUrl, setTraceViewerUrl] = useState<string | null>(null)
  
  const outputRef = useRef<HTMLPreElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Fetch test files on mount
  useEffect(() => {
    async function fetchTestFiles() {
      try {
        const response = await fetch(`/api/projects/${projectId}/tests/list`)
        if (response.ok) {
          const data = await response.json()
          setTestFiles(data.files || [])
          // Auto-expand first file
          if (data.files?.length > 0) {
            setExpandedFiles(new Set([data.files[0].path]))
          }
        }
      } catch (err) {
        console.error('[TestPanel] Failed to fetch test files:', err)
      } finally {
        setIsLoadingFiles(false)
      }
    }
    fetchTestFiles()
  }, [projectId])

  // Refresh test files
  const refreshTestFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/tests/list`)
      if (response.ok) {
        const data = await response.json()
        setTestFiles(data.files || [])
      }
    } catch (err) {
      console.error('[TestPanel] Failed to refresh test files:', err)
    } finally {
      setIsLoadingFiles(false)
    }
  }, [projectId])

  // Fetch traces
  const fetchTraces = useCallback(async () => {
    setIsLoadingTraces(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/tests/traces`)
      if (response.ok) {
        const data = await response.json()
        setTraces(data.traces || [])
      }
    } catch (err) {
      console.error('[TestPanel] Failed to fetch traces:', err)
    } finally {
      setIsLoadingTraces(false)
    }
  }, [projectId])

  // Fetch traces when execution completes
  useEffect(() => {
    if (execution.status === 'success' || execution.status === 'error') {
      // Wait a bit for trace files to be written
      const timer = setTimeout(() => {
        fetchTraces()
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [execution.status, fetchTraces])

  // Open trace in viewer
  const openTrace = useCallback((trace: TraceFile) => {
    setActiveTrace(trace)
    setShowTraceViewer(true)
    
    // Construct the full URL to the trace file
    // trace.playwright.dev accepts a trace URL parameter
    const traceFileUrl = `${window.location.origin}/api/projects/${projectId}/tests/traces/${encodeURIComponent(trace.path)}`
    const viewerUrl = `https://trace.playwright.dev/?trace=${encodeURIComponent(traceFileUrl)}`
    setTraceViewerUrl(viewerUrl)
  }, [projectId])

  // Close trace viewer
  const closeTraceViewer = useCallback(() => {
    setShowTraceViewer(false)
    setActiveTrace(null)
    if (traceViewerUrl) {
      URL.revokeObjectURL(traceViewerUrl)
      setTraceViewerUrl(null)
    }
  }, [traceViewerUrl])

  // Download trace file
  const downloadTrace = useCallback(async (trace: TraceFile) => {
    try {
      const response = await fetch(`/api/projects/${projectId}/tests/traces/${encodeURIComponent(trace.path)}`)
      if (response.ok) {
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = trace.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('[TestPanel] Failed to download trace:', err)
    }
  }, [projectId])

  // Clear traces
  const clearTraces = useCallback(async () => {
    try {
      await fetch(`/api/projects/${projectId}/tests/traces`, { method: 'DELETE' })
      setTraces([])
    } catch (err) {
      console.error('[TestPanel] Failed to clear traces:', err)
    }
  }, [projectId])

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && execution.status === 'running') {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [execution.output, execution.status])

  // Parse test summary from current output
  const testSummary = useMemo(() => {
    if (execution.status === 'idle') return null
    return parseTestSummary(execution.output)
  }, [execution.output, execution.status])

  /**
   * Run tests with given command ID (legacy preset commands)
   */
  const runTests = useCallback(async (commandId: string, label: string) => {
    // Cancel any existing execution
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const newExecution: TestExecution = {
      commandId,
      label,
      startTime: Date.now(),
      output: '',
      status: 'running',
    }

    setExecution(newExecution)

    try {
      const response = await fetch(`/api/projects/${projectId}/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        // Try to parse as JSON, but handle text responses
        const contentType = response.headers.get('content-type') || ''
        let errorMessage = 'Failed to start tests'
        if (contentType.includes('application/json')) {
          try {
            const error = await response.json()
            errorMessage = error.error?.message || errorMessage
          } catch {
            // Fall back to text if JSON parsing fails
            errorMessage = await response.text() || errorMessage
          }
        } else {
          errorMessage = await response.text() || errorMessage
        }
        newExecution.output = `Error: ${errorMessage}\n`
        newExecution.status = 'error'
        setExecution({ ...newExecution })
        setHistory(prev => [newExecution, ...prev])
        return
      }

      // Stream the response
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        newExecution.output = 'Error: No response body\n'
        newExecution.status = 'error'
        setExecution({ ...newExecution })
        setHistory(prev => [newExecution, ...prev])
        return
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        newExecution.output += text
        setExecution({ ...newExecution })
      }

      // Parse exit code from output
      const exitCodeMatch = newExecution.output.match(/\[Process exited with code (\d+)\]/)
      if (exitCodeMatch) {
        newExecution.exitCode = parseInt(exitCodeMatch[1], 10)
        newExecution.status = newExecution.exitCode === 0 ? 'success' : 'error'
      } else {
        newExecution.status = 'success'
      }

      setExecution({ ...newExecution })
      setHistory(prev => [newExecution, ...prev])

    } catch (err: any) {
      if (err.name === 'AbortError') {
        newExecution.output += '\n[Tests cancelled]\n'
        newExecution.status = 'error'
      } else {
        newExecution.output = `Error: ${err.message}\n`
        newExecution.status = 'error'
      }
      setExecution({ ...newExecution })
      setHistory(prev => [newExecution, ...prev])
    } finally {
      abortControllerRef.current = null
    }
  }, [projectId])

  /**
   * Run specific test file or test case (Option B)
   */
  const runSpecificTest = useCallback(async (file?: string, testName?: string, headed?: boolean) => {
    // Cancel any existing execution
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const label = testName 
      ? `${testName} (${file?.split('/').pop()})` 
      : file?.split('/').pop() || 'Tests'

    const newExecution: TestExecution = {
      commandId: 'specific-test',
      label: headed ? `${label} (Headed)` : label,
      startTime: Date.now(),
      output: '',
      status: 'running',
      file,
      testName,
    }

    setExecution(newExecution)
    setSelectedFile(file || null)

    try {
      const response = await fetch(`/api/projects/${projectId}/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, testName, headed }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        // Try to parse as JSON, but handle text responses
        const contentType = response.headers.get('content-type') || ''
        let errorMessage = 'Failed to start tests'
        if (contentType.includes('application/json')) {
          try {
            const error = await response.json()
            errorMessage = error.error?.message || errorMessage
          } catch {
            // Fall back to text if JSON parsing fails
            errorMessage = await response.text() || errorMessage
          }
        } else {
          errorMessage = await response.text() || errorMessage
        }
        newExecution.output = `Error: ${errorMessage}\n`
        newExecution.status = 'error'
        setExecution({ ...newExecution })
        setHistory(prev => [newExecution, ...prev])
        return
      }

      // Stream the response
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        newExecution.output = 'Error: No response body\n'
        newExecution.status = 'error'
        setExecution({ ...newExecution })
        setHistory(prev => [newExecution, ...prev])
        return
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        newExecution.output += text
        setExecution({ ...newExecution })
      }

      // Parse exit code from output
      const exitCodeMatch = newExecution.output.match(/\[Process exited with code (\d+)\]/)
      if (exitCodeMatch) {
        newExecution.exitCode = parseInt(exitCodeMatch[1], 10)
        newExecution.status = newExecution.exitCode === 0 ? 'success' : 'error'
      } else {
        newExecution.status = 'success'
      }

      setExecution({ ...newExecution })
      setHistory(prev => [newExecution, ...prev])

    } catch (err: any) {
      if (err.name === 'AbortError') {
        newExecution.output += '\n[Tests cancelled]\n'
        newExecution.status = 'error'
      } else {
        newExecution.output = `Error: ${err.message}\n`
        newExecution.status = 'error'
      }
      setExecution({ ...newExecution })
      setHistory(prev => [newExecution, ...prev])
    } finally {
      abortControllerRef.current = null
    }
  }, [projectId])

  /**
   * Stop running tests
   */
  const stopTests = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }, [])

  /**
   * Clear output
   */
  const clearOutput = useCallback(() => {
    setExecution({
      commandId: '',
      label: '',
      startTime: 0,
      output: '',
      status: 'idle',
    })
    setHistory([])
    setSelectedFile(null)
  }, [])

  /**
   * Toggle file expansion
   */
  const toggleFileExpand = useCallback((path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const isRunning = execution.status === 'running'
  const hasOutput = execution.output.length > 0
  const hasTestFiles = testFiles.length > 0
  const totalTests = testFiles.reduce((sum, f) => sum + f.tests.length, 0)
  const hasTraces = traces.length > 0

  // Calculate elapsed time
  const elapsedTime = useMemo(() => {
    if (!execution.startTime || execution.status === 'idle') return null
    const elapsed = (execution.status === 'running' ? Date.now() : (execution.exitCode !== undefined ? Date.now() : execution.startTime)) - execution.startTime
    if (elapsed < 1000) return '<1s'
    if (elapsed < 60000) return `${Math.round(elapsed / 1000)}s`
    return `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`
  }, [execution.startTime, execution.status, execution.exitCode])

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <TestTube className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Tests</span>
          {hasTestFiles && (
            <span className="text-xs text-muted-foreground">
              ({testFiles.length} file{testFiles.length !== 1 ? 's' : ''}, {totalTests} test{totalTests !== 1 ? 's' : ''})
            </span>
          )}
          {testSummary && execution.status !== 'running' && (
            <div className="flex items-center gap-2 ml-2">
              {testSummary.passed > 0 && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3 w-3" />
                  {testSummary.passed}
                </span>
              )}
              {testSummary.failed > 0 && (
                <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                  <XCircle className="h-3 w-3" />
                  {testSummary.failed}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refreshTestFiles}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Refresh test files"
            disabled={isLoadingFiles}
          >
            <RefreshCw className={cn(
              "h-3.5 w-3.5 text-muted-foreground",
              isLoadingFiles && "animate-spin"
            )} />
          </button>
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className={cn(
              "p-1.5 rounded hover:bg-muted transition-colors",
              showSidebar && "bg-muted"
            )}
            title={showSidebar ? "Hide test files" : "Show test files"}
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={fetchTraces}
            className={cn(
              "p-1.5 rounded hover:bg-muted transition-colors relative",
              hasTraces && "text-purple-500"
            )}
            title="View test traces"
            disabled={isLoadingTraces}
          >
            <Film className={cn(
              "h-3.5 w-3.5",
              isLoadingTraces && "animate-pulse",
              hasTraces ? "text-purple-500" : "text-muted-foreground"
            )} />
            {hasTraces && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-purple-500 rounded-full" />
            )}
          </button>
          <button
            onClick={clearOutput}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Clear Output"
            disabled={isRunning}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/10">
        {isRunning ? (
          <button
            onClick={stopTests}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md",
              "bg-red-500/10 text-red-600 dark:text-red-400",
              "hover:bg-red-500/20 transition-colors"
            )}
          >
            <XCircle className="h-4 w-4" />
            Stop Tests
          </button>
        ) : (
          <>
            <button
              onClick={() => runTests('playwright-test', 'Run Tests')}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md",
                "bg-primary text-primary-foreground",
                "hover:bg-primary/90 transition-colors"
              )}
            >
              <Play className="h-4 w-4" />
              Run Tests
            </button>
            <button
              onClick={() => runTests('playwright-test-headed', 'Run Tests (Visible)')}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md",
                "border border-border",
                "hover:bg-muted transition-colors"
              )}
              title="Run tests with browser visible"
            >
              <Eye className="h-4 w-4" />
              Headed
            </button>
            {execution.status === 'error' && execution.commandId && (
              <button
                onClick={() => {
                  if (execution.file) {
                    runSpecificTest(execution.file, execution.testName)
                  } else {
                    runTests(execution.commandId, execution.label)
                  }
                }}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md",
                  "border border-border text-amber-600 dark:text-amber-400",
                  "hover:bg-muted transition-colors"
                )}
                title="Re-run last test"
              >
                <RotateCcw className="h-4 w-4" />
                Retry
              </button>
            )}
          </>
        )}
        
        {/* Elapsed time */}
        {elapsedTime && execution.status !== 'idle' && (
          <div className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {elapsedTime}
          </div>
        )}
      </div>

      {/* Main content: Sidebar + Output */}
      <div className="flex flex-1 min-h-0">
        {/* Test files sidebar */}
        {showSidebar && (
          <div className="w-56 border-r overflow-y-auto bg-muted/10 shrink-0">
            {isLoadingFiles ? (
              <div className="flex items-center justify-center h-20">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !hasTestFiles ? (
              <div className="p-4 text-xs text-muted-foreground text-center">
                No test files found.
                <br />
                <span className="text-[10px]">
                  Create files matching *.test.ts in /tests
                </span>
              </div>
            ) : (
              <div className="py-2">
                {testFiles.map((file) => (
                  <div key={file.path} className="mb-1">
                    {/* File header */}
                    <div className="flex items-center">
                      <button
                        onClick={() => toggleFileExpand(file.path)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                      >
                        {expandedFiles.has(file.path) ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        onClick={() => runSpecificTest(file.path)}
                        disabled={isRunning}
                        className={cn(
                          "flex-1 flex items-center gap-2 px-2 py-1 text-xs text-left transition-colors",
                          "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed",
                          selectedFile === file.path && "bg-muted"
                        )}
                        title={`Run all tests in ${file.name}`}
                      >
                        <FileCode className="h-3 w-3 text-blue-400 shrink-0" />
                        <span className="truncate">{file.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {file.tests.length}
                        </span>
                      </button>
                      <button
                        onClick={() => runSpecificTest(file.path, undefined, true)}
                        disabled={isRunning}
                        className={cn(
                          "p-1 text-muted-foreground hover:text-foreground transition-colors",
                          "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                        title="Run headed"
                      >
                        <Eye className="h-3 w-3" />
                      </button>
                    </div>

                    {/* Individual tests */}
                    {expandedFiles.has(file.path) && file.tests.length > 0 && (
                      <div className="ml-6 border-l border-border/50">
                        {file.tests.map((test, idx) => (
                          <button
                            key={`${file.path}-${idx}`}
                            onClick={() => runSpecificTest(file.path, test.title)}
                            disabled={isRunning}
                            className={cn(
                              "flex items-center gap-2 w-full px-3 py-1 text-xs text-left transition-colors",
                              "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed",
                              "text-muted-foreground hover:text-foreground"
                            )}
                            title={test.fullTitle}
                          >
                            <Play className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">{test.title}</span>
                            {test.line && (
                              <span className="ml-auto text-[10px] text-muted-foreground/50">
                                :{test.line}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Traces section */}
            {hasTraces && (
              <div className="border-t py-2">
                <div className="px-3 py-1 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-purple-500 uppercase tracking-wide flex items-center gap-1">
                    <Film className="h-3 w-3" />
                    Traces
                  </span>
                  <button
                    onClick={clearTraces}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    title="Clear all traces"
                  >
                    Clear
                  </button>
                </div>
                {traces.map((trace) => {
                  // Extract test name from path (e.g., test-results/test-name-chromium/trace.zip)
                  const testName = trace.path.split('/')[1]?.replace(/-chromium$/, '') || trace.name
                  const sizeKb = Math.round(trace.size / 1024)
                  const modified = new Date(trace.modified)
                  const timeAgo = getTimeAgo(modified)
                  
                  return (
                    <div
                      key={trace.path}
                      className="flex items-center gap-1 px-3 py-1.5 hover:bg-muted/50 group"
                    >
                      <button
                        onClick={() => openTrace(trace)}
                        className="flex-1 flex items-center gap-2 text-xs text-left text-muted-foreground hover:text-foreground truncate"
                        title={`View trace: ${trace.path}`}
                      >
                        <Film className="h-3 w-3 text-purple-400 shrink-0" />
                        <span className="truncate">{testName}</span>
                      </button>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">
                        {sizeKb}KB
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0 hidden group-hover:block">
                        {timeAgo}
                      </span>
                      <button
                        onClick={() => downloadTrace(trace)}
                        className="p-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                        title="Download trace"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Output area */}
        <div className="flex-1 flex flex-col min-w-0">
          <pre
            ref={outputRef}
            className={cn(
              "flex-1 p-4 overflow-auto font-mono text-xs leading-relaxed",
              "bg-zinc-950 text-zinc-100",
              "whitespace-pre-wrap break-all"
            )}
          >
            {hasOutput ? (
              highlightOutput(execution.output)
            ) : (
              <span className="text-zinc-500">
                {hasTestFiles ? (
                  <>
                    Click "Run Tests" to execute all tests, or select a specific test from the sidebar.
                    {'\n\n'}
                    Options:{'\n'}
                    • Run Tests - Execute all tests in headless mode{'\n'}
                    • Headed - Run with visible browser (useful for debugging){'\n'}
                    • Click a file - Run all tests in that file{'\n'}
                    • Click a test - Run just that test{'\n'}
                    • Retry - Re-run the last test after failures{'\n'}
                  </>
                ) : (
                  <>
                    No test files found in your project.
                    {'\n\n'}
                    To add tests:{'\n'}
                    • Create a /tests directory{'\n'}
                    • Add files matching *.test.ts or *.spec.ts{'\n'}
                    • Use Playwright test framework{'\n'}
                    {'\n'}
                    Example: tests/e2e.test.ts
                  </>
                )}
              </span>
            )}
            {isRunning && (
              <span className="inline-flex items-center gap-1 text-blue-400">
                <Loader2 className="h-3 w-3 animate-spin inline" />
                {' '}Running...
              </span>
            )}
          </pre>

          {/* Status bar */}
          {execution.status !== 'idle' && (
            <div className={cn(
              "px-4 py-2 text-xs border-t flex items-center justify-between",
              execution.status === 'running' && "bg-blue-500/10 border-blue-500/20",
              execution.status === 'success' && "bg-green-500/10 border-green-500/20",
              execution.status === 'error' && "bg-red-500/10 border-red-500/20"
            )}>
              <div className="flex items-center gap-3">
                <span className={cn(
                  "font-medium flex items-center gap-1.5",
                  execution.status === 'running' && "text-blue-600 dark:text-blue-400",
                  execution.status === 'success' && "text-green-600 dark:text-green-400",
                  execution.status === 'error' && "text-red-600 dark:text-red-400"
                )}>
                  {execution.status === 'running' && (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running tests...
                    </>
                  )}
                  {execution.status === 'success' && (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      All tests passed
                    </>
                  )}
                  {execution.status === 'error' && (
                    <>
                      <XCircle className="h-3 w-3" />
                      {testSummary?.failed 
                        ? `${testSummary.failed} test${testSummary.failed > 1 ? 's' : ''} failed`
                        : 'Tests failed'
                      }
                    </>
                  )}
                </span>
                
                {/* Summary badges */}
                {testSummary && execution.status !== 'running' && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>{testSummary.total} total</span>
                    {testSummary.duration && (
                      <span>in {testSummary.duration}</span>
                    )}
                  </div>
                )}
              </div>
              
              <span className="text-muted-foreground">
                {execution.label}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Trace Viewer Overlay */}
      {showTraceViewer && activeTrace && (
        <div className="absolute inset-0 z-50 bg-background flex flex-col">
          {/* Trace viewer header */}
          <div className="flex items-center justify-between px-4 py-2 border-b bg-purple-500/10">
            <div className="flex items-center gap-3">
              <Film className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-medium">Trace Viewer</span>
              <span className="text-xs text-muted-foreground">
                {activeTrace.path.split('/')[1]?.replace(/-chromium$/, '') || activeTrace.name}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {traceViewerUrl && (
                <a
                  href={traceViewerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md",
                    "border border-border hover:bg-muted transition-colors"
                  )}
                  title="Open in new tab"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in New Tab
                </a>
              )}
              <button
                onClick={() => downloadTrace(activeTrace)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md",
                  "border border-border hover:bg-muted transition-colors"
                )}
              >
                <Download className="h-3 w-3" />
                Download
              </button>
              <button
                onClick={closeTraceViewer}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Close trace viewer"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Trace viewer content - embedded iframe */}
          <div className="flex-1 flex flex-col min-h-0">
            {traceViewerUrl ? (
              <iframe
                src={traceViewerUrl}
                className="flex-1 w-full border-0"
                title="Playwright Trace Viewer"
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">Loading trace viewer...</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TestPanel
