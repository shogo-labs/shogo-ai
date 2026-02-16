/**
 * SecurityPanel - Automated security scanning for project workspace
 *
 * Provides a full-featured UI for running security scans:
 * - One-click "Run Scan" to analyze project code
 * - Findings list grouped by severity (Critical, High, Medium, Low, Info)
 * - Expandable finding details with code snippets and recommendations
 * - Summary dashboard with severity counts
 * - Scan history within the session
 *
 * Uses the /api/projects/:projectId/security/scan endpoint.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react"
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Play,
  Loader2,
  FileCode,
  Lightbulb,
  RefreshCw,
  Clock,
  Bug,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Package,
  Wrench,
  EyeOff,
  Eye,
  Check,
  Undo2,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ============================================================================
// Types (matching API response)
// ============================================================================

type Severity = "critical" | "high" | "medium" | "low" | "info"

interface SecurityFinding {
  id: string
  title: string
  severity: Severity
  category: string
  description: string
  file: string
  line: number
  snippet: string
  recommendation: string
}

interface ScanSummary {
  total: number
  critical: number
  high: number
  medium: number
  low: number
  info: number
  filesScanned: number
  durationMs: number
  aiAnalysis?: boolean
  vulnerableDeps?: number
}

interface ScanResult {
  ok: boolean
  findings: SecurityFinding[]
  summary: ScanSummary
}

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_CONFIG: Record<
  Severity,
  {
    label: string
    icon: typeof ShieldAlert
    color: string
    bgColor: string
    badgeColor: string
    borderColor: string
  }
> = {
  critical: {
    label: "Critical",
    icon: ShieldX,
    color: "text-red-600 dark:text-red-400",
    bgColor: "bg-red-500/10",
    badgeColor: "bg-red-500 text-white",
    borderColor: "border-red-500/30",
  },
  high: {
    label: "High",
    icon: ShieldAlert,
    color: "text-orange-600 dark:text-orange-400",
    bgColor: "bg-orange-500/10",
    badgeColor: "bg-orange-500 text-white",
    borderColor: "border-orange-500/30",
  },
  medium: {
    label: "Medium",
    icon: AlertTriangle,
    color: "text-yellow-600 dark:text-yellow-400",
    bgColor: "bg-yellow-500/10",
    badgeColor: "bg-yellow-600 text-white",
    borderColor: "border-yellow-500/30",
  },
  low: {
    label: "Low",
    icon: Info,
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-500/10",
    badgeColor: "bg-blue-500 text-white",
    borderColor: "border-blue-500/30",
  },
  info: {
    label: "Info",
    icon: Info,
    color: "text-muted-foreground",
    bgColor: "bg-muted/30",
    badgeColor: "bg-muted-foreground text-background",
    borderColor: "border-border",
  },
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"]

// ============================================================================
// Sub-components
// ============================================================================

/** Severity badge pill */
function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  const config = SEVERITY_CONFIG[severity]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide",
        config.badgeColor
      )}
    >
      {config.label}
      {count !== undefined && <span>({count})</span>}
    </span>
  )
}

/** Score ring / grade display */
function SecurityScore({ summary }: { summary: ScanSummary }) {
  const { critical, high, medium, low, total } = summary

  let grade: string
  let gradeColor: string
  let ringColor: string

  if (total === 0) {
    grade = "A+"
    gradeColor = "text-green-500"
    ringColor = "border-green-500"
  } else if (critical > 0) {
    grade = "F"
    gradeColor = "text-red-500"
    ringColor = "border-red-500"
  } else if (high > 0) {
    grade = high > 3 ? "D" : "D+"
    gradeColor = "text-orange-500"
    ringColor = "border-orange-500"
  } else if (medium > 0) {
    grade = medium > 5 ? "C" : "B-"
    gradeColor = "text-yellow-500"
    ringColor = "border-yellow-500"
  } else if (low > 0) {
    grade = "B+"
    gradeColor = "text-blue-500"
    ringColor = "border-blue-500"
  } else {
    grade = "A"
    gradeColor = "text-green-500"
    ringColor = "border-green-500"
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={cn(
          "w-16 h-16 rounded-full border-4 flex items-center justify-center",
          ringColor
        )}
      >
        <span className={cn("text-2xl font-bold", gradeColor)}>{grade}</span>
      </div>
      <span className="text-[10px] text-muted-foreground font-medium">Security Score</span>
    </div>
  )
}

/** Summary stat card */
function SummaryStat({
  severity,
  count,
}: {
  severity: Severity
  count: number
}) {
  const config = SEVERITY_CONFIG[severity]
  const Icon = config.icon
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-md border",
        config.bgColor,
        config.borderColor,
        count === 0 && "opacity-50"
      )}
    >
      <Icon className={cn("h-4 w-4", config.color)} />
      <div className="flex flex-col">
        <span className={cn("text-sm font-bold", count > 0 ? config.color : "text-muted-foreground")}>
          {count}
        </span>
        <span className="text-[10px] text-muted-foreground">{config.label}</span>
      </div>
    </div>
  )
}

/** Finding status: open, resolved (user confirmed fixed), or ignored (user dismissed) */
type FindingStatus = "open" | "resolved" | "ignored"

/** Single expandable finding */
function FindingCard({
  finding,
  isExpanded,
  status,
  onToggle,
  onFix,
  onStatusChange,
}: {
  finding: SecurityFinding
  isExpanded: boolean
  status: FindingStatus
  onToggle: () => void
  onFix?: () => void
  onStatusChange?: (status: FindingStatus) => void
}) {
  const config = SEVERITY_CONFIG[finding.severity]
  const Icon = config.icon
  const isDismissed = status === "resolved" || status === "ignored"

  return (
    <div
      className={cn(
        "border rounded-lg overflow-hidden transition-colors",
        config.borderColor,
        isDismissed && "opacity-50",
        isExpanded && config.bgColor
      )}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors",
          "hover:bg-muted/50"
        )}
      >
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {isDismissed ? (
            status === "resolved" ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            )
          ) : (
            <Icon className={cn("h-4 w-4", config.color)} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-sm font-medium", isDismissed ? "text-muted-foreground line-through" : "text-foreground")}>
              {finding.title}
            </span>
            {!isDismissed && <SeverityBadge severity={finding.severity} />}
            {status === "resolved" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/10 text-green-600 dark:text-green-400">
                Resolved
              </span>
            )}
            {status === "ignored" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-muted-foreground">
                Ignored
              </span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {finding.category}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <FileCode className="h-3 w-3" />
            <span>{finding.file}:{finding.line}</span>
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
          {finding.id.split("-")[0]}
        </span>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border/50">
          {/* Description */}
          <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
            {finding.description}
          </p>

          {/* Code snippet */}
          <div className="mt-3">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1 mb-1">
              <Bug className="h-3 w-3" />
              Code
            </span>
            <pre className="p-3 rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-x-auto">
              <span className="text-zinc-500 select-none">{finding.line} │ </span>
              <span className="text-red-300">{finding.snippet}</span>
            </pre>
          </div>

          {/* Recommendation */}
          <div className="mt-3 flex gap-2 p-3 rounded-md bg-green-500/5 border border-green-500/20">
            <Lightbulb className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="text-[10px] font-medium text-green-600 dark:text-green-400 uppercase tracking-wide">
                Recommendation
              </span>
              <p className="text-xs text-foreground mt-1 leading-relaxed">
                {finding.recommendation}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {/* Fix with AI button */}
            {onFix && finding.severity !== "info" && !isDismissed && (
              <button
                onClick={(e) => { e.stopPropagation(); onFix(); }}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md",
                  "bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20",
                  "hover:bg-purple-500/20 transition-colors"
                )}
              >
                <Wrench className="h-3 w-3" />
                Fix with AI
              </button>
            )}

            {/* Resolve / Ignore / Reopen buttons */}
            {onStatusChange && !isDismissed && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onStatusChange("resolved"); }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md",
                    "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20",
                    "hover:bg-green-500/20 transition-colors"
                  )}
                >
                  <Check className="h-3 w-3" />
                  Resolve
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onStatusChange("ignored"); }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md",
                    "bg-muted text-muted-foreground border border-border",
                    "hover:bg-muted/80 transition-colors"
                  )}
                >
                  <EyeOff className="h-3 w-3" />
                  Ignore
                </button>
              </>
            )}
            {onStatusChange && isDismissed && (
              <button
                onClick={(e) => { e.stopPropagation(); onStatusChange("open"); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md",
                  "bg-muted text-muted-foreground border border-border",
                  "hover:bg-muted/80 transition-colors"
                )}
              >
                <Undo2 className="h-3 w-3" />
                Reopen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Utilities
// ============================================================================

/** Format milliseconds into a human-readable duration string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ============================================================================
// Main Component
// ============================================================================

export interface SecurityPanelProps {
  /** Project ID to scan */
  projectId: string
  /** Additional CSS classes */
  className?: string
  /** Callback to send a fix message to the chat agent */
  onFixWithAI?: (message: string) => void
  /**
   * Auto-scan trigger: increment this number to automatically
   * trigger a background security scan (e.g. after AI code generation).
   * Does nothing when 0 or undefined.
   */
  autoScanTrigger?: number
}

export function SecurityPanel({ projectId, className, onFixWithAI, autoScanTrigger }: SecurityPanelProps) {
  // Scan state
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null)

  // UI state
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const [filterSeverity, setFilterSeverity] = useState<Severity | "all">("all")
  const [showDismissed, setShowDismissed] = useState(false)

  // Finding lifecycle state: tracks resolved/ignored findings by ID (client-side only)
  const [findingStatuses, setFindingStatuses] = useState<Record<string, FindingStatus>>({})

  // Track auto-scan trigger to prevent running on mount
  const prevAutoScanTrigger = useRef(autoScanTrigger ?? 0)

  // Run security scan
  const runScan = useCallback(async () => {
    setIsScanning(true)
    setScanError(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/security/scan`, {
        method: "POST",
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(
          data?.error?.message || `Scan failed with status ${response.status}`
        )
      }

      const result: ScanResult = await response.json()
      setScanResult(result)
      setLastScanTime(new Date())
      setExpandedFindings(new Set())

      // Send notification for critical/high findings (fire-and-forget)
      if (result.ok && (result.summary.critical > 0 || result.summary.high > 0)) {
        fetch(`/api/projects/${projectId}/security/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            critical: result.summary.critical,
            high: result.summary.high,
            total: result.summary.total,
          }),
        }).catch((err) => {
          console.warn("[SecurityPanel] Failed to send notification:", err)
        })
      }
    } catch (err: any) {
      setScanError(err.message || "Failed to run security scan")
      setScanResult(null)
    } finally {
      setIsScanning(false)
    }
  }, [projectId])

  // Update finding status (resolve/ignore/reopen)
  const setFindingStatus = useCallback((findingId: string, status: FindingStatus) => {
    setFindingStatuses((prev) => ({ ...prev, [findingId]: status }))
  }, [])

  // Count dismissed findings
  const dismissedCount = useMemo(() => {
    if (!scanResult?.findings) return 0
    return scanResult.findings.filter(
      (f) => findingStatuses[f.id] === "resolved" || findingStatuses[f.id] === "ignored"
    ).length
  }, [scanResult?.findings, findingStatuses])

  // Auto-scan when trigger changes (after AI code generation)
  useEffect(() => {
    const trigger = autoScanTrigger ?? 0
    if (trigger > 0 && trigger !== prevAutoScanTrigger.current) {
      prevAutoScanTrigger.current = trigger
      // Debounce: wait 2s after AI finishes to let file writes settle
      const timer = setTimeout(() => {
        runScan()
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [autoScanTrigger, runScan])

  // Toggle finding expansion
  const toggleFinding = useCallback((findingId: string) => {
    setExpandedFindings((prev) => {
      const next = new Set(prev)
      if (next.has(findingId)) {
        next.delete(findingId)
      } else {
        next.add(findingId)
      }
      return next
    })
  }, [])

  // Filtered findings (respects severity filter and dismissed toggle)
  const filteredFindings = useMemo(() => {
    if (!scanResult?.findings) return []
    return scanResult.findings.filter((f) => {
      // Severity filter
      if (filterSeverity !== "all" && f.severity !== filterSeverity) return false
      // Dismissed filter
      if (!showDismissed) {
        const s = findingStatuses[f.id]
        if (s === "resolved" || s === "ignored") return false
      }
      return true
    })
  }, [scanResult?.findings, filterSeverity, showDismissed, findingStatuses])

  // Build a prompt to fix all issues with AI
  const handleFixAll = useCallback(() => {
    if (!scanResult || !onFixWithAI || scanResult.summary.total === 0) return
    const issueList = scanResult.findings
      .filter((f) => f.severity !== "info")
      .slice(0, 10) // Limit to top 10 issues
      .map((f) => `- [${f.severity.toUpperCase()}] ${f.title} in ${f.file}:${f.line} — ${f.recommendation}`)
      .join("\n")
    onFixWithAI(
      `Security scan found ${scanResult.summary.total} issues. Please fix the following security vulnerabilities in my project:\n\n${issueList}`
    )
  }, [scanResult, onFixWithAI])

  // Build a prompt to fix a single issue with AI
  const handleFixSingle = useCallback(
    (finding: SecurityFinding) => {
      if (!onFixWithAI) return
      onFixWithAI(
        `Fix this security issue in my project:\n\n**${finding.title}** (${finding.severity}) in \`${finding.file}:${finding.line}\`\n\nCode: \`${finding.snippet}\`\n\nIssue: ${finding.description}\n\nRecommended fix: ${finding.recommendation}`
      )
    },
    [onFixWithAI]
  )

  // Group findings by severity for display
  const findingsByCategory = useMemo(() => {
    const groups: Record<string, SecurityFinding[]> = {}
    for (const finding of filteredFindings) {
      const key = finding.category
      if (!groups[key]) groups[key] = []
      groups[key].push(finding)
    }
    return groups
  }, [filteredFindings])

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Security</span>
          {scanResult && (
            <div className="flex items-center gap-2 ml-2">
              {scanResult.summary.critical > 0 && (
                <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                  <XCircle className="h-3 w-3" />
                  {scanResult.summary.critical}
                </span>
              )}
              {scanResult.summary.high > 0 && (
                <span className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                  <AlertCircle className="h-3 w-3" />
                  {scanResult.summary.high}
                </span>
              )}
              {scanResult.summary.total === 0 && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Clean
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {lastScanTime && (
            <span className="text-[10px] text-muted-foreground mr-2">
              {lastScanTime.toLocaleTimeString()}
            </span>
          )}
          {scanResult && (
            <button
              onClick={runScan}
              disabled={isScanning}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="Re-scan"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground",
                  isScanning && "animate-spin"
                )}
              />
            </button>
          )}
        </div>
      </div>

      {/* Action bar - always visible */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/10">
        <button
          onClick={runScan}
          disabled={isScanning}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md",
            "bg-primary text-primary-foreground",
            "hover:bg-primary/90 transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {isScanning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning...
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              {scanResult ? "Re-scan" : "Run Security Scan"}
            </>
          )}
        </button>

        {/* Severity filter pills */}
        {scanResult && scanResult.summary.total > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => setFilterSeverity("all")}
              className={cn(
                "px-2 py-1 text-[10px] font-medium rounded-md transition-colors",
                filterSeverity === "all"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              All ({scanResult.summary.total})
            </button>
            {SEVERITY_ORDER.map((sev) => {
              const count = scanResult.summary[sev]
              if (count === 0) return null
              const config = SEVERITY_CONFIG[sev]
              return (
                <button
                  key={sev}
                  onClick={() =>
                    setFilterSeverity(filterSeverity === sev ? "all" : sev)
                  }
                  className={cn(
                    "px-2 py-1 text-[10px] font-medium rounded-md transition-colors",
                    filterSeverity === sev
                      ? cn(config.bgColor, config.color, "ring-1", config.borderColor)
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  {config.label} ({count})
                </button>
              )
            })}
          </div>
        )}

        {/* Dismissed toggle + Scan metadata */}
        {scanResult && dismissedCount > 0 && (
          <button
            onClick={() => setShowDismissed(!showDismissed)}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ml-auto",
              showDismissed
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {showDismissed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {dismissedCount} dismissed
          </button>
        )}
        {scanResult && (
          <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", dismissedCount === 0 && "ml-auto", "ml-2")}>
            <Clock className="h-3 w-3" />
            {formatDuration(scanResult.summary.durationMs)}
            <span className="text-muted-foreground/50">•</span>
            {scanResult.summary.filesScanned} files
          </div>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto relative">
        {/* Error state */}
        {scanError && (
          <div className="flex flex-col items-center justify-center h-full p-8">
            <div className="flex flex-col items-center gap-4 max-w-md text-center">
              <ShieldX className="h-12 w-12 text-destructive" />
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  Scan Failed
                </h3>
                <p className="text-sm text-muted-foreground mt-1">{scanError}</p>
              </div>
              <button
                onClick={runScan}
                disabled={isScanning}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isScanning && !scanResult && (
          <div className="flex flex-col items-center justify-center h-full p-8">
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <Shield className="h-12 w-12 text-primary animate-pulse" />
                <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 text-primary animate-spin" />
              </div>
              <div className="text-center">
                <h3 className="text-sm font-medium text-foreground">
                  Scanning project files...
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Checking for vulnerabilities, exposed secrets, and security issues
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Empty state (no scan run yet) */}
        {!scanResult && !isScanning && !scanError && (
          <div className="flex flex-col items-center justify-center h-full p-8">
            <div className="flex flex-col items-center gap-6 max-w-md text-center">
              <div className="relative">
                <Shield className="h-16 w-16 text-muted-foreground/30" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  Security Scanner
                </h3>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                  Analyze your project for security vulnerabilities, exposed secrets,
                  XSS risks, SQL injection, insecure configurations, and more.
                </p>
              </div>
              <button
                onClick={runScan}
                className={cn(
                  "flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-lg",
                  "bg-primary text-primary-foreground",
                  "hover:bg-primary/90 transition-colors",
                  "shadow-sm"
                )}
              >
                <Play className="h-4 w-4" />
                Run Security Scan
              </button>
              <div className="grid grid-cols-2 gap-3 text-left w-full max-w-sm">
                <div className="flex items-start gap-2 p-2">
                  <ShieldAlert className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-medium">Secrets Detection</span>
                    <p className="text-[10px] text-muted-foreground">
                      API keys, passwords, tokens
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-2">
                  <Bug className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-medium">XSS & Injection</span>
                    <p className="text-[10px] text-muted-foreground">
                      XSS, SQL injection, eval()
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-medium">Configuration</span>
                    <p className="text-[10px] text-muted-foreground">
                      CORS, HTTPS, debug flags
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-2">
                  <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-medium">Best Practices</span>
                    <p className="text-[10px] text-muted-foreground">
                      Dependencies, crypto, auth
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scan results */}
        {scanResult && !isScanning && (
          <div className="p-4 space-y-4">
            {/* Summary dashboard */}
            <div className="flex items-start gap-6 p-4 rounded-lg border bg-card">
              <SecurityScore summary={scanResult.summary} />
              <div className="flex-1">
                <div className="flex items-center gap-4 flex-wrap">
                  {SEVERITY_ORDER.map((sev) => (
                    <SummaryStat
                      key={sev}
                      severity={sev}
                      count={scanResult.summary[sev]}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground flex-wrap">
                  <span>{scanResult.summary.filesScanned} files scanned</span>
                  <span className="text-muted-foreground/50">•</span>
                  <span>{scanResult.summary.total} issues found</span>
                  <span className="text-muted-foreground/50">•</span>
                  <span>{formatDuration(scanResult.summary.durationMs)}</span>
                  {(scanResult.summary.vulnerableDeps ?? 0) > 0 && (
                    <>
                      <span className="text-muted-foreground/50">•</span>
                      <span className="inline-flex items-center gap-1 text-orange-500">
                        <Package className="h-3 w-3" />
                        {scanResult.summary.vulnerableDeps} vulnerable deps
                      </span>
                    </>
                  )}
                </div>
                {/* Fix with AI button */}
                {onFixWithAI && scanResult.summary.total > 0 && scanResult.summary.total - scanResult.summary.info > 0 && (
                  <button
                    onClick={handleFixAll}
                    className={cn(
                      "mt-3 flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md",
                      "bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20",
                      "hover:bg-purple-500/20 transition-colors"
                    )}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    Fix All with AI
                  </button>
                )}
              </div>
            </div>

            {/* All clean state */}
            {scanResult.summary.total === 0 && (
              <div className="flex flex-col items-center gap-3 py-12">
                <ShieldCheck className="h-16 w-16 text-green-500" />
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-green-600 dark:text-green-400">
                    No Issues Found
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your project passed all security checks. Great job!
                  </p>
                </div>
              </div>
            )}

            {/* Findings list */}
            {filteredFindings.length > 0 && (
              <div className="space-y-4">
                {Object.entries(findingsByCategory).map(([category, findings]) => (
                  <div key={category}>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                      {category}
                      <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-muted">
                        {findings.length}
                      </span>
                    </h4>
                    <div className="space-y-2">
                      {findings.map((finding) => (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          isExpanded={expandedFindings.has(finding.id)}
                          status={findingStatuses[finding.id] || "open"}
                          onToggle={() => toggleFinding(finding.id)}
                          onFix={onFixWithAI ? () => handleFixSingle(finding) : undefined}
                          onStatusChange={(status) => setFindingStatus(finding.id, status)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Scanning overlay on re-scan */}
        {isScanning && scanResult && (
          <div className="absolute inset-0 bg-background/60 flex items-center justify-center z-10">
            <div className="flex flex-col items-center gap-3 p-6 rounded-lg bg-card border shadow-lg">
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
              <span className="text-sm font-medium">Re-scanning...</span>
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      {scanResult && !isScanning && (
        <div
          className={cn(
            "px-4 py-2 text-xs border-t flex items-center justify-between",
            scanResult.summary.critical > 0 && "bg-red-500/10 border-red-500/20",
            scanResult.summary.critical === 0 &&
              scanResult.summary.high > 0 &&
              "bg-orange-500/10 border-orange-500/20",
            scanResult.summary.critical === 0 &&
              scanResult.summary.high === 0 &&
              scanResult.summary.total > 0 &&
              "bg-yellow-500/10 border-yellow-500/20",
            scanResult.summary.total === 0 && "bg-green-500/10 border-green-500/20"
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "font-medium flex items-center gap-1.5",
                scanResult.summary.critical > 0 && "text-red-600 dark:text-red-400",
                scanResult.summary.critical === 0 &&
                  scanResult.summary.high > 0 &&
                  "text-orange-600 dark:text-orange-400",
                scanResult.summary.critical === 0 &&
                  scanResult.summary.high === 0 &&
                  scanResult.summary.total > 0 &&
                  "text-yellow-600 dark:text-yellow-400",
                scanResult.summary.total === 0 &&
                  "text-green-600 dark:text-green-400"
              )}
            >
              {scanResult.summary.total === 0 ? (
                <>
                  <ShieldCheck className="h-3 w-3" />
                  All checks passed
                </>
              ) : scanResult.summary.critical > 0 ? (
                <>
                  <ShieldX className="h-3 w-3" />
                  {scanResult.summary.critical} critical issue
                  {scanResult.summary.critical > 1 ? "s" : ""} found
                </>
              ) : scanResult.summary.high > 0 ? (
                <>
                  <ShieldAlert className="h-3 w-3" />
                  {scanResult.summary.high} high severity issue
                  {scanResult.summary.high > 1 ? "s" : ""} found
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  {scanResult.summary.total} issue
                  {scanResult.summary.total > 1 ? "s" : ""} found
                </>
              )}
            </span>
          </div>
          <span className="text-muted-foreground">
            {scanResult.summary.filesScanned} files •{" "}
            {formatDuration(scanResult.summary.durationMs)}
          </span>
        </div>
      )}
    </div>
  )
}

export default SecurityPanel

