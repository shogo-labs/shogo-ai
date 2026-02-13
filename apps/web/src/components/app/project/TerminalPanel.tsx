/**
 * TerminalPanel - Execute preset shell commands on project workspace
 *
 * Provides a UI for running common development commands like:
 * - bun install
 * - prisma generate/push/reset
 * - playwright test
 * - tsc typecheck
 *
 * Features:
 * - Preset command buttons grouped by category
 * - Streaming command output display
 * - Confirmation dialog for destructive commands
 * - Command history (current session)
 */

import { useState, useRef, useCallback, useEffect } from "react"
import {
  Play,
  Loader2,
  Package,
  Database,
  TestTube,
  Hammer,
  AlertTriangle,
  Terminal,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Preset command from API
 */
interface PresetCommand {
  id: string
  label: string
  description: string
  category: string
  dangerous: boolean
}

/**
 * Commands grouped by category
 */
interface CommandsByCategory {
  package?: PresetCommand[]
  database?: PresetCommand[]
  server?: PresetCommand[]
  test?: PresetCommand[]
  build?: PresetCommand[]
}

/**
 * Command execution result
 */
interface CommandExecution {
  commandId: string
  label: string
  startTime: number
  output: string
  status: 'running' | 'success' | 'error'
  exitCode?: number
}

export interface TerminalPanelProps {
  /** Project ID to execute commands for */
  projectId: string
  /** Additional CSS classes */
  className?: string
  /** Callback to restart the dev server (optional) */
  onRestartServer?: () => void
  /** Callback to trigger a rebuild */
  onRebuild?: () => Promise<void>
  /** Current build error if any */
  buildError?: string | null
  /** Build error context */
  buildErrorContext?: {
    category?: string
    rootCause?: string
    suggestions?: string[]
  } | null
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  package: <Package className="h-4 w-4" />,
  database: <Database className="h-4 w-4" />,
  server: <RefreshCw className="h-4 w-4" />,
  test: <TestTube className="h-4 w-4" />,
  build: <Hammer className="h-4 w-4" />,
}

const CATEGORY_LABELS: Record<string, string> = {
  package: 'Package Management',
  database: 'Database',
  server: 'Server',
  test: 'Testing',
  build: 'Build',
}

export function TerminalPanel({
  projectId,
  className,
  onRestartServer,
  onRebuild,
  buildError,
  buildErrorContext,
}: TerminalPanelProps) {
  const [commands, setCommands] = useState<CommandsByCategory>({})
  const [isLoadingCommands, setIsLoadingCommands] = useState(true)
  const [currentExecution, setCurrentExecution] = useState<CommandExecution | null>(null)
  const [history, setHistory] = useState<CommandExecution[]>([])
  const [confirmingCommand, setConfirmingCommand] = useState<PresetCommand | null>(null)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['package', 'database'])
  )
  const [activeTab, setActiveTab] = useState<'commands' | 'buildLog'>('commands')
  const [buildLog, setBuildLog] = useState<string>('')
  const [isLoadingBuildLog, setIsLoadingBuildLog] = useState(false)
  const [isRebuilding, setIsRebuilding] = useState(false)
  
  const outputRef = useRef<HTMLPreElement>(null)
  const buildLogRef = useRef<HTMLPreElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Fetch available commands on mount
  useEffect(() => {
    async function fetchCommands() {
      try {
        const response = await fetch(`/api/projects/${projectId}/terminal/commands`)
        if (response.ok) {
          const data = await response.json()
          setCommands(data.commands || {})
        }
      } catch (err) {
        console.error('[TerminalPanel] Failed to fetch commands:', err)
      } finally {
        setIsLoadingCommands(false)
      }
    }
    fetchCommands()
  }, [projectId])

  // Fetch build log from runtime
  const fetchBuildLog = useCallback(async () => {
    setIsLoadingBuildLog(true)
    try {
      // Get sandbox URL first to know the runtime URL
      const sandboxResponse = await fetch(`/api/projects/${projectId}/sandbox/url`)
      if (!sandboxResponse.ok) {
        console.error('[TerminalPanel] Failed to get sandbox URL')
        return
      }
      const sandboxData = await sandboxResponse.json()
      const url = new URL(sandboxData.url)
      const baseUrl = `${url.protocol}//${url.host}`
      
      const response = await fetch(`${baseUrl}/build-log?lines=200`)
      if (response.ok) {
        const data = await response.json()
        setBuildLog(data.log || '')
      }
    } catch (err) {
      console.error('[TerminalPanel] Failed to fetch build log:', err)
    } finally {
      setIsLoadingBuildLog(false)
    }
  }, [projectId])

  // Auto-switch to build log tab when there's a build error
  useEffect(() => {
    if (buildError) {
      setActiveTab('buildLog')
      fetchBuildLog()
    }
  }, [buildError, fetchBuildLog])

  // Fetch build log when switching to build log tab
  useEffect(() => {
    if (activeTab === 'buildLog') {
      fetchBuildLog()
    }
  }, [activeTab, fetchBuildLog])

  // Handle rebuild button click
  const handleRebuild = useCallback(async () => {
    if (!onRebuild || isRebuilding) return
    setIsRebuilding(true)
    try {
      await onRebuild()
      // Refresh build log after rebuild
      await fetchBuildLog()
    } finally {
      setIsRebuilding(false)
    }
  }, [onRebuild, isRebuilding, fetchBuildLog])

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && currentExecution) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [currentExecution?.output])

  // Auto-scroll build log
  useEffect(() => {
    if (buildLogRef.current && buildLog) {
      buildLogRef.current.scrollTop = buildLogRef.current.scrollHeight
    }
  }, [buildLog])

  /**
   * Execute a preset command
   */
  const executeCommand = useCallback(async (command: PresetCommand, confirmDangerous = false) => {
    // Cancel any existing execution
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const execution: CommandExecution = {
      commandId: command.id,
      label: command.label,
      startTime: Date.now(),
      output: '',
      status: 'running',
    }

    setCurrentExecution(execution)
    setConfirmingCommand(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: command.id,
          confirmDangerous,
        }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const error = await response.json()
        execution.output = `Error: ${error.error?.message || 'Command failed'}\n`
        execution.status = 'error'
        setCurrentExecution({ ...execution })
        setHistory(prev => [execution, ...prev])
        return
      }

      // Stream the response
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        execution.output = 'Error: No response body\n'
        execution.status = 'error'
        setCurrentExecution({ ...execution })
        setHistory(prev => [execution, ...prev])
        return
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        execution.output += text
        setCurrentExecution({ ...execution })
      }

      // Parse exit code from output
      const exitCodeMatch = execution.output.match(/\[Process exited with code (\d+)\]/)
      if (exitCodeMatch) {
        execution.exitCode = parseInt(exitCodeMatch[1], 10)
        execution.status = execution.exitCode === 0 ? 'success' : 'error'
      } else {
        execution.status = 'success'
      }

      setCurrentExecution({ ...execution })
      setHistory(prev => [execution, ...prev])

    } catch (err: any) {
      if (err.name === 'AbortError') {
        execution.output += '\n[Aborted]\n'
        execution.status = 'error'
      } else {
        execution.output = `Error: ${err.message}\n`
        execution.status = 'error'
      }
      setCurrentExecution({ ...execution })
      setHistory(prev => [execution, ...prev])
    } finally {
      abortControllerRef.current = null
    }
  }, [projectId])

  /**
   * Handle command click - show confirmation for dangerous commands
   */
  const handleCommandClick = useCallback((command: PresetCommand) => {
    if (command.dangerous) {
      setConfirmingCommand(command)
    } else {
      executeCommand(command)
    }
  }, [executeCommand])

  /**
   * Clear output and history
   */
  const clearOutput = useCallback(() => {
    setCurrentExecution(null)
    setHistory([])
  }, [])

  /**
   * Toggle category expansion
   */
  const toggleCategory = useCallback((category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(category)) {
        next.delete(category)
      } else {
        next.add(category)
      }
      return next
    })
  }, [])

  const isRunning = currentExecution?.status === 'running'

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-4">
          {/* Tab buttons */}
          <button
            onClick={() => setActiveTab('commands')}
            className={cn(
              "flex items-center gap-2 px-2 py-1 text-sm font-medium rounded transition-colors",
              activeTab === 'commands' 
                ? "bg-background text-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Terminal className="h-4 w-4" />
            Commands
          </button>
          <button
            onClick={() => setActiveTab('buildLog')}
            className={cn(
              "flex items-center gap-2 px-2 py-1 text-sm font-medium rounded transition-colors",
              activeTab === 'buildLog' 
                ? "bg-background text-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground",
              buildError && activeTab !== 'buildLog' && "text-red-500"
            )}
          >
            <Hammer className="h-4 w-4" />
            Build Log
            {buildError && (
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-1">
          {activeTab === 'buildLog' && onRebuild && (
            <button
              onClick={handleRebuild}
              disabled={isRebuilding}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
                isRebuilding && "opacity-50 cursor-not-allowed"
              )}
              title="Trigger full rebuild"
            >
              {isRebuilding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Rebuild
            </button>
          )}
          {activeTab === 'buildLog' && (
            <button
              onClick={fetchBuildLog}
              disabled={isLoadingBuildLog}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Refresh Build Log"
            >
              <RefreshCw className={cn(
                "h-3.5 w-3.5 text-muted-foreground",
                isLoadingBuildLog && "animate-spin"
              )} />
            </button>
          )}
          {activeTab === 'commands' && onRestartServer && (
            <button
              onClick={onRestartServer}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Restart Dev Server"
            >
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          {activeTab === 'commands' && (
            <button
              onClick={clearOutput}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Clear Output"
              disabled={isRunning}
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Build Log Tab Content */}
      {activeTab === 'buildLog' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Error banner if there's a build error */}
          {buildError && (
            <div className="px-4 py-3 bg-red-500/10 border-b border-red-500/20">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    Build Error
                  </p>
                  <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-1">
                    {buildErrorContext?.rootCause || buildError}
                  </p>
                  {buildErrorContext?.suggestions && buildErrorContext.suggestions.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">Suggestions:</p>
                      <ul className="mt-1 space-y-1">
                        {buildErrorContext.suggestions.map((suggestion, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                            <span className="text-primary">•</span>
                            {suggestion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          
          {/* Build log output */}
          <pre
            ref={buildLogRef}
            className={cn(
              "flex-1 p-4 overflow-auto font-mono text-xs leading-relaxed",
              "bg-zinc-950 text-zinc-100",
              "whitespace-pre-wrap break-all"
            )}
          >
            {isLoadingBuildLog ? (
              <span className="text-zinc-500">Loading build log...</span>
            ) : buildLog ? (
              buildLog
            ) : (
              <span className="text-zinc-500">
                No build log available yet.
                {'\n\n'}
                The build log will appear here when you make changes to your code.
              </span>
            )}
          </pre>
        </div>
      )}

      {/* Commands Tab Content */}
      {activeTab === 'commands' && (
      <div className="flex flex-1 min-h-0">
        {/* Command sidebar */}
        <div className="w-56 border-r overflow-y-auto bg-muted/10">
          {isLoadingCommands ? (
            <div className="flex items-center justify-center h-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="py-2">
              {Object.entries(commands).map(([category, categoryCommands]) => (
                <div key={category} className="mb-1">
                  {/* Category header */}
                  <button
                    onClick={() => toggleCategory(category)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                  >
                    {expandedCategories.has(category) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {CATEGORY_ICONS[category]}
                    {CATEGORY_LABELS[category] || category}
                  </button>

                  {/* Category commands */}
                  {expandedCategories.has(category) && (
                    <div className="ml-2">
                      {categoryCommands?.map((cmd: PresetCommand) => (
                        <button
                          key={cmd.id}
                          onClick={() => handleCommandClick(cmd)}
                          disabled={isRunning}
                          className={cn(
                            "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors",
                            "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed",
                            cmd.dangerous && "text-amber-600 dark:text-amber-500",
                            currentExecution?.commandId === cmd.id && isRunning && "bg-muted"
                          )}
                          title={cmd.description}
                        >
                          {currentExecution?.commandId === cmd.id && isRunning ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          <span className="truncate">{cmd.label}</span>
                          {cmd.dangerous && (
                            <AlertTriangle className="h-3 w-3 ml-auto shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

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
            {currentExecution ? (
              currentExecution.output || 'Running...\n'
            ) : (
              <span className="text-zinc-500">
                Select a command from the sidebar to execute it.
                {'\n\n'}
                Available commands:{'\n'}
                • Install Dependencies - Install packages with bun{'\n'}
                • Generate Prisma Client - Regenerate after schema changes{'\n'}
                • Push Schema - Apply schema to database{'\n'}
                • Reset Database - Wipe and recreate (destructive){'\n'}
                • Run Tests - Execute Playwright tests{'\n'}
                • Type Check - Run TypeScript checking{'\n'}
              </span>
            )}
          </pre>

          {/* Status bar */}
          {currentExecution && (
            <div className={cn(
              "px-4 py-1.5 text-xs border-t flex items-center justify-between",
              currentExecution.status === 'running' && "bg-blue-500/10 border-blue-500/20",
              currentExecution.status === 'success' && "bg-green-500/10 border-green-500/20",
              currentExecution.status === 'error' && "bg-red-500/10 border-red-500/20"
            )}>
              <span className={cn(
                "font-medium",
                currentExecution.status === 'running' && "text-blue-600 dark:text-blue-400",
                currentExecution.status === 'success' && "text-green-600 dark:text-green-400",
                currentExecution.status === 'error' && "text-red-600 dark:text-red-400"
              )}>
                {currentExecution.status === 'running' && 'Running...'}
                {currentExecution.status === 'success' && 'Completed'}
                {currentExecution.status === 'error' && `Failed (exit ${currentExecution.exitCode ?? '?'})`}
              </span>
              <span className="text-muted-foreground">
                {currentExecution.label}
              </span>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Confirmation dialog for dangerous commands */}
      {confirmingCommand && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg shadow-lg p-6 max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-amber-500/10">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold">Destructive Command</h3>
                <p className="text-sm text-muted-foreground">
                  {confirmingCommand.label}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              {confirmingCommand.description}. This action cannot be undone.
              Are you sure you want to proceed?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmingCommand(null)}
                className="px-4 py-2 text-sm rounded-md hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => executeCommand(confirmingCommand, true)}
                className="px-4 py-2 text-sm rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
              >
                Yes, Execute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TerminalPanel
