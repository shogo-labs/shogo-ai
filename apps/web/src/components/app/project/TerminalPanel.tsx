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
}: TerminalPanelProps) {
  const [commands, setCommands] = useState<CommandsByCategory>({})
  const [isLoadingCommands, setIsLoadingCommands] = useState(true)
  const [currentExecution, setCurrentExecution] = useState<CommandExecution | null>(null)
  const [history, setHistory] = useState<CommandExecution[]>([])
  const [confirmingCommand, setConfirmingCommand] = useState<PresetCommand | null>(null)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['package', 'database'])
  )
  
  const outputRef = useRef<HTMLPreElement>(null)
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

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && currentExecution) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [currentExecution?.output])

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
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Terminal</span>
        </div>
        <div className="flex items-center gap-1">
          {onRestartServer && (
            <button
              onClick={onRestartServer}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Restart Dev Server"
            >
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
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
                      {categoryCommands?.map((cmd) => (
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
