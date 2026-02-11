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
  Monitor,
  Square,
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
  line?: number
  watch?: boolean
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
  // Strip ANSI codes before matching so patterns work reliably
  const clean = stripAnsi(output)
  // Playwright outputs: "X passed", "X failed", "X skipped"
  const passedMatch = clean.match(/(\d+)\s+passed/)
  const failedMatch = clean.match(/(\d+)\s+failed/)
  const skippedMatch = clean.match(/(\d+)\s+skipped/)
  const durationMatch = clean.match(/\((\d+(?:\.\d+)?[ms]+)\)/)
  
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
 * Strip ANSI escape codes from a string.
 * Handles color, style, cursor movement, and other terminal sequences.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\([A-Z])/g, '')
}

/**
 * Render test output with syntax highlighting and inline attachments.
 * 1. Strips ANSI escape codes so output is clean.
 * 2. Highlights pass/fail/skip/error lines with appropriate colors.
 * 3. Detects Playwright attachment references (screenshot, trace, video)
 *    and renders them as clickable links or inline images.
 */
function highlightOutput(output: string, projectId?: string): React.ReactNode[] {
  const clean = stripAnsi(output)
  const lines = clean.split('\n')
  const nodes: React.ReactNode[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // --- Inline screenshot attachment ---
    // Playwright outputs lines like:
    //   test-results/test-name-chromium/test-failed-1.png
    const screenshotMatch = line.match(/^\s*(test-results\/\S+\.png)\s*$/)
    if (screenshotMatch && projectId) {
      const imgPath = screenshotMatch[1]
      const imgUrl = `/api/projects/${projectId}/files/${imgPath}`
      nodes.push(
        <span key={i} className="block my-2">
          <a href={imgUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline text-xs">
            View screenshot: {imgPath.split('/').pop()}
          </a>
          <img
            src={imgUrl}
            alt="Test screenshot"
            className="mt-1 max-w-full max-h-64 rounded border border-zinc-700"
            loading="lazy"
          />
          {'\n'}
        </span>
      )
      continue
    }

    // --- Trace attachment link ---
    const traceMatch = line.match(/^\s*(test-results\/\S+\/trace\.zip)\s*$/)
    if (traceMatch && projectId) {
      const tracePath = traceMatch[1]
      const traceFileUrl = `/api/projects/${projectId}/files/${tracePath}`
      const viewerUrl = `https://trace.playwright.dev/?trace=${encodeURIComponent(window.location.origin + traceFileUrl)}`
      nodes.push(
        <span key={i} className="block my-1">
          <a href={viewerUrl} target="_blank" rel="noopener noreferrer" className="text-purple-400 underline text-xs inline-flex items-center gap-1">
            <Film className="h-3 w-3 inline" />
            View trace
          </a>
          {'\n'}
        </span>
      )
      continue
    }

    // --- Video attachment - inline player ---
    const videoMatch = line.match(/^\s*(test-results\/\S+\.webm)\s*$/)
    if (videoMatch && projectId) {
      const videoPath = videoMatch[1]
      const videoUrl = `/api/projects/${projectId}/files/${videoPath}`
      nodes.push(
        <span key={i} className="block my-2">
          <span className="text-blue-400 text-xs flex items-center gap-1 mb-1">
            <Film className="h-3 w-3 inline" />
            Test Recording: {videoPath.split('/').pop()}
          </span>
          <video
            src={videoUrl}
            controls
            autoPlay
            muted
            playsInline
            className="max-w-full rounded border border-zinc-700"
            style={{ maxHeight: '400px' }}
          />
          {'\n'}
        </span>
      )
      continue
    }

    // --- Highlight passed tests ---
    if (line.includes('✓') || line.includes('✔') || /\d+\s+passed/.test(line)) {
      nodes.push(<span key={i} className="text-green-400">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight failed tests ---
    if (line.includes('✘') || line.includes('✗') || /\d+\s+failed/.test(line)) {
      nodes.push(<span key={i} className="text-red-400">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight errors and stack traces ---
    if (/Error[:.]/.test(line) || /^\s+at\s/.test(line)) {
      nodes.push(<span key={i} className="text-red-300">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight retry lines ---
    if (/retry #\d+/i.test(line)) {
      nodes.push(<span key={i} className="text-yellow-400">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight skipped tests ---
    if (line.includes('skipped') || line.includes('⊘')) {
      nodes.push(<span key={i} className="text-yellow-400">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight source code lines (line numbers from error output) ---
    if (/^\s*\d+\s*\|/.test(line)) {
      // Error pointer line
      if (line.includes('>') || line.includes('^')) {
        nodes.push(<span key={i} className="text-red-300 font-semibold">{line}{'\n'}</span>)
      } else {
        nodes.push(<span key={i} className="text-zinc-400">{line}{'\n'}</span>)
      }
      continue
    }

    // --- Highlight attachment header lines (dim them) ---
    if (/attachment #\d+:/.test(line) || /^[\s─]+$/.test(line) || /^-+\s*Test Artifacts\s*-+$/.test(line)) {
      nodes.push(<span key={i} className="text-zinc-500">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight "Running N test" header ---
    if (/Running \d+ test/.test(line)) {
      nodes.push(<span key={i} className="text-blue-300">{line}{'\n'}</span>)
      continue
    }

    // --- Highlight test file paths ---
    if (/\.test\.(ts|js|tsx|jsx)/.test(line) && /›/.test(line)) {
      nodes.push(<span key={i} className="text-blue-300">{line}{'\n'}</span>)
      continue
    }

    // --- Command echo line ---
    if (/^\$\s/.test(line)) {
      nodes.push(<span key={i} className="text-zinc-400 font-semibold">{line}{'\n'}</span>)
      continue
    }

    // --- Default ---
    nodes.push(<span key={i}>{line}{'\n'}</span>)
  }

  return nodes
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

  // Playwright UI mode state
  const [playwrightUI, setPlaywrightUI] = useState<{
    status: 'idle' | 'starting' | 'running' | 'stopping' | 'error'
    url?: string
    error?: string
  }>({ status: 'idle' })
  // Fallback proxy URL for K8s mode (when direct URL isn't available)
  const playwrightUIProxyUrl = useMemo(() => `/api/projects/${projectId}/tests/ui/app/`, [projectId])
  
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
    // Encode each path segment individually to preserve '/' separators
    const traceFileUrl = `${window.location.origin}/api/projects/${projectId}/tests/traces/${trace.path.split('/').map(encodeURIComponent).join('/')}`
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

  // Start Playwright UI mode
  const startPlaywrightUI = useCallback(async () => {
    if (playwrightUI.status === 'running' || playwrightUI.status === 'starting') return

    setPlaywrightUI({ status: 'starting' })

    try {
      const response = await fetch(`/api/projects/${projectId}/tests/ui/start`, {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: { message: 'Failed to start Playwright UI' } }))
        setPlaywrightUI({ status: 'error', error: data.error?.message || 'Failed to start' })
        return
      }

      const data = await response.json()
      // The API returns a direct URL to the Playwright UI server (e.g. http://localhost:9323)
      // Using the direct URL avoids proxy issues with absolute asset paths in the Playwright SPA
      const uiUrl = data.url || undefined
      if (data.status === 'running') {
        setPlaywrightUI({ status: 'running', url: uiUrl })
      } else if (data.status === 'error') {
        setPlaywrightUI({ status: 'error', error: data.error || 'Failed to start' })
      } else {
        // Still starting, poll for status
        const pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/projects/${projectId}/tests/ui/status`)
            const statusData = await statusRes.json()
            if (statusData.status === 'running') {
              setPlaywrightUI({ status: 'running', url: uiUrl })
              clearInterval(pollInterval)
            } else if (statusData.status === 'error' || statusData.status === 'idle') {
              setPlaywrightUI({ status: 'error', error: statusData.error || 'Failed to start' })
              clearInterval(pollInterval)
            }
          } catch {
            clearInterval(pollInterval)
            setPlaywrightUI({ status: 'error', error: 'Lost connection' })
          }
        }, 1000)
        // Timeout after 15 seconds
        setTimeout(() => {
          clearInterval(pollInterval)
          setPlaywrightUI(prev => prev.status === 'starting' ? { status: 'error', error: 'Startup timed out' } : prev)
        }, 15000)
      }
    } catch (err: any) {
      setPlaywrightUI({ status: 'error', error: err.message || 'Failed to start' })
    }
  }, [projectId, playwrightUI.status])

  // Stop Playwright UI mode
  const stopPlaywrightUI = useCallback(async () => {
    setPlaywrightUI({ status: 'stopping' })
    try {
      await fetch(`/api/projects/${projectId}/tests/ui/stop`, { method: 'POST' })
    } catch {
      // Ignore errors when stopping
    }
    setPlaywrightUI({ status: 'idle' })
  }, [projectId])

  const isPlaywrightUIActive = playwrightUI.status === 'running' || playwrightUI.status === 'starting'

  // Cleanup Playwright UI on unmount
  useEffect(() => {
    return () => {
      // Stop Playwright UI when component unmounts
      fetch(`/api/projects/${projectId}/tests/ui/stop`, { method: 'POST' }).catch(() => {})
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
   * Run specific test file or test case (Option B).
   * When line is provided, Playwright runs only the test at that line (file:line); otherwise uses file + optional testName (grep).
   */
  const runSpecificTest = useCallback(async (file?: string, testName?: string, headed?: boolean, line?: number, watch?: boolean) => {
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
      label: watch ? `${label} (Watch)` : headed ? `${label} (Headed)` : label,
      startTime: Date.now(),
      output: '',
      status: 'running',
      file,
      testName,
      line,
      watch,
    }

    setExecution(newExecution)
    setSelectedFile(file || null)

    try {
      const response = await fetch(`/api/projects/${projectId}/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, testName, headed, line, watch }),
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
        ) : playwrightUI.status === 'running' ? (
          <button
            onClick={stopPlaywrightUI}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md",
              "bg-purple-500/10 text-purple-600 dark:text-purple-400",
              "hover:bg-purple-500/20 transition-colors"
            )}
          >
            <Square className="h-4 w-4" />
            Close UI Mode
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
              onClick={startPlaywrightUI}
              disabled={playwrightUI.status === 'starting' || playwrightUI.status === 'stopping'}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md",
                "border border-border",
                "hover:bg-muted transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                playwrightUI.status === 'starting' && "animate-pulse"
              )}
              title="Open interactive Playwright UI with visible browser"
            >
              {playwrightUI.status === 'starting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
              {playwrightUI.status === 'starting' ? 'Starting UI...' : 'UI Mode'}
            </button>
            {execution.status === 'error' && execution.commandId && (
              <button
                onClick={() => {
                  if (execution.file) {
                    runSpecificTest(execution.file, execution.testName, false, execution.line)
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
        {/* Test files sidebar - hidden in Playwright UI mode since it has its own test list */}
        {showSidebar && !isPlaywrightUIActive && playwrightUI.status !== 'running' && (
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
                    </div>

                    {/* Individual tests */}
                    {expandedFiles.has(file.path) && file.tests.length > 0 && (
                      <div className="ml-6 border-l border-border/50">
                        {file.tests.map((test, idx) => (
                          <div
                            key={`${file.path}-${idx}`}
                            className={cn(
                              "flex items-center gap-1 w-full px-3 py-1 text-xs transition-colors group/test",
                              "hover:bg-muted/50",
                              "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <button
                              onClick={() => runSpecificTest(file.path, test.title, false, test.line)}
                              disabled={isRunning}
                              className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                              title={`Run: ${test.fullTitle}`}
                            >
                              <Play className="h-2.5 w-2.5" />
                            </button>
                            <button
                              onClick={() => runSpecificTest(file.path, test.title, false, test.line, true)}
                              disabled={isRunning}
                              className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                              title={`Watch: ${test.fullTitle}`}
                            >
                              <Film className="h-2.5 w-2.5" />
                            </button>
                            <span className="truncate flex-1 min-w-0">{test.title}</span>
                            {test.line && (
                              <span className="text-[10px] text-muted-foreground/50 shrink-0">
                                :{test.line}
                              </span>
                            )}
                          </div>
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
          {/* Playwright UI iframe mode */}
          {playwrightUI.status === 'running' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <iframe
                src={playwrightUI.url || playwrightUIProxyUrl}
                className="flex-1 w-full border-0"
                title="Playwright UI"
                allow="clipboard-read; clipboard-write"
              />
              <div className="px-4 py-2 text-xs border-t flex items-center justify-between bg-purple-500/10 border-purple-500/20">
                <span className="font-medium text-purple-600 dark:text-purple-400 flex items-center gap-1.5">
                  <Monitor className="h-3 w-3" />
                  Playwright UI Mode
                </span>
                <span className="text-muted-foreground text-[10px]">
                  Interactive test runner with visible browser
                </span>
              </div>
            </div>
          ) : playwrightUI.status === 'starting' ? (
            <div className="flex-1 flex items-center justify-center bg-zinc-950">
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
                <div className="text-center">
                  <p className="text-sm font-medium text-zinc-200">Starting Playwright UI...</p>
                  <p className="text-xs text-zinc-500 mt-1">This may take a few seconds on first launch</p>
                </div>
              </div>
            </div>
          ) : playwrightUI.status === 'error' ? (
            <div className="flex-1 flex items-center justify-center bg-zinc-950">
              <div className="flex flex-col items-center gap-4">
                <XCircle className="h-8 w-8 text-red-400" />
                <div className="text-center">
                  <p className="text-sm font-medium text-zinc-200">Failed to start Playwright UI</p>
                  <p className="text-xs text-red-400 mt-1">{playwrightUI.error}</p>
                  <button
                    onClick={startPlaywrightUI}
                    className={cn(
                      "mt-3 flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md",
                      "border border-border hover:bg-muted transition-colors"
                    )}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry
                  </button>
                </div>
              </div>
            </div>
          ) : execution.watch && execution.status !== 'idle' ? (
            <>
              {/* Watch mode: show only video player(s) */}
              <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 p-6 overflow-auto">
                {execution.status === 'running' ? (
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-zinc-200">Recording test...</p>
                      <p className="text-xs text-zinc-500 mt-1">{execution.label}</p>
                    </div>
                  </div>
                ) : (() => {
                  // Extract video paths from output
                  const videoUrls = (execution.output.match(/test-results\/\S+\.webm/g) || [])
                    .map(p => `/api/projects/${projectId}/files/${p}`)
                  return videoUrls.length > 0 ? (
                    <div className="w-full max-w-2xl space-y-4">
                      {videoUrls.map((url, i) => (
                        <div key={i} className="rounded-lg overflow-hidden border border-zinc-700">
                          <video
                            src={url}
                            controls
                            autoPlay
                            muted
                            playsInline
                            className="w-full"
                          />
                        </div>
                      ))}
                      <p className="text-center text-xs text-zinc-500">{execution.label}</p>
                    </div>
                  ) : (
                    <div className="text-center">
                      <p className="text-sm text-zinc-400">No video recorded</p>
                      <p className="text-xs text-zinc-600 mt-1">
                        The project may need a playwright.watch.config.ts file
                      </p>
                    </div>
                  )
                })()}
              </div>
            </>
          ) : (
            <>
              <pre
                ref={outputRef}
                className={cn(
                  "flex-1 p-4 overflow-auto font-mono text-xs leading-relaxed",
                  "bg-zinc-950 text-zinc-100",
                  "whitespace-pre-wrap break-all"
                )}
              >
                {hasOutput ? (
                  highlightOutput(execution.output, projectId)
                ) : (
                  <span className="text-zinc-500">
                    {hasTestFiles ? (
                      <>
                        Click "Run Tests" to execute all tests, or select a specific test from the sidebar.
                        {'\n\n'}
                        Options:{'\n'}
                        • Run Tests - Execute all tests in headless mode{'\n'}
                        • UI Mode - Open interactive Playwright UI with visible browser{'\n'}
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
            </>
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
