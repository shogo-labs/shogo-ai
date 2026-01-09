/**
 * EntityDataPanel - Panel showing entity counts and data for a feature session
 *
 * Displays:
 * - Requirement count and list
 * - AnalysisFinding count and list
 * - DesignDecision count and list
 * - ImplementationTask count and list with status
 */

import { useState, useEffect, useCallback } from "react"
import { mcpService } from "@/services/mcpService"
import { cn } from "@/lib/utils"

interface EntityDataPanelProps {
  featureSessionId: string | null
}

interface EntityCounts {
  requirements: number
  findings: number
  decisions: number
  tasks: number
}

interface Requirement {
  id: string
  name: string
  description: string
  priority: string
  status: string
}

interface Finding {
  id: string
  name: string
  type: string // "pattern", "gap", "risk", etc.
  description: string
}

interface Decision {
  id: string
  name: string
  question: string
  decision: string
}

interface Task {
  id: string
  name: string
  description: string
  status: string
}

export function EntityDataPanel({ featureSessionId }: EntityDataPanelProps) {
  const [counts, setCounts] = useState<EntityCounts>({
    requirements: 0,
    findings: 0,
    decisions: 0,
    tasks: 0,
  })
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!featureSessionId) {
      setCounts({ requirements: 0, findings: 0, decisions: 0, tasks: 0 })
      setRequirements([])
      setFindings([])
      setDecisions([])
      setTasks([])
      return
    }

    try {
      setLoading(true)

      // Ensure schema is loaded first
      await mcpService.callTool("schema.load", { name: "platform-features" })

      // Load all entities and filter client-side by session
      const [reqResult, findResult, decResult, taskResult] = await Promise.all([
        mcpService.callTool("store.query", {
          schema: "platform-features",
          model: "Requirement",
        }),
        mcpService.callTool("store.query", {
          schema: "platform-features",
          model: "AnalysisFinding",
        }),
        mcpService.callTool("store.query", {
          schema: "platform-features",
          model: "DesignDecision",
        }),
        mcpService.callTool("store.query", {
          schema: "platform-features",
          model: "ImplementationTask",
        }),
      ])

      // Filter by session client-side
      const allReqs = reqResult.items || []
      const allFindings = findResult.items || []
      const allDecisions = decResult.items || []
      const allTasks = taskResult.items || []

      const filteredReqs = allReqs.filter((r: any) => r.session === featureSessionId)
      const filteredFindings = allFindings.filter((f: any) => f.session === featureSessionId)
      const filteredDecisions = allDecisions.filter((d: any) => d.session === featureSessionId)
      const filteredTasks = allTasks.filter((t: any) => t.session === featureSessionId)

      setRequirements(filteredReqs)
      setFindings(filteredFindings)
      setDecisions(filteredDecisions)
      setTasks(filteredTasks)

      setCounts({
        requirements: filteredReqs.length,
        findings: filteredFindings.length,
        decisions: filteredDecisions.length,
        tasks: filteredTasks.length,
      })
    } catch (err) {
      console.error("[EntityDataPanel] Error loading data:", err)
    } finally {
      setLoading(false)
    }
  }, [featureSessionId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Poll for updates every 30 seconds when a session is selected
  useEffect(() => {
    if (!featureSessionId) return
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [featureSessionId, loadData])

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section)
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "must":
        return "text-red-400"
      case "should":
        return "text-yellow-400"
      case "could":
        return "text-green-400"
      default:
        return "text-muted-foreground"
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-400"
      case "in_progress":
        return "bg-blue-400"
      case "blocked":
        return "bg-red-400"
      default:
        return "bg-muted"
    }
  }

  if (!featureSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a feature session to view entities
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 bg-card border-b border-border font-medium">
        Feature Data
        {loading && (
          <span className="ml-2 text-xs text-muted-foreground">
            Refreshing...
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Requirements Section */}
        <CollapsibleSection
          title="Requirements"
          count={counts.requirements}
          expanded={expandedSection === "requirements"}
          onToggle={() => toggleSection("requirements")}
        >
          {requirements.map((req) => (
            <div
              key={req.id}
              className="px-3 py-2 text-sm border-b border-border last:border-0"
            >
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-medium", getPriorityColor(req.priority))}>
                  [{req.priority?.toUpperCase() || "?"}]
                </span>
                <span>{req.name}</span>
              </div>
            </div>
          ))}
        </CollapsibleSection>

        {/* Findings Section */}
        <CollapsibleSection
          title="Analysis Findings"
          count={counts.findings}
          expanded={expandedSection === "findings"}
          onToggle={() => toggleSection("findings")}
        >
          {findings.map((finding) => (
            <div
              key={finding.id}
              className="px-3 py-2 text-sm border-b border-border last:border-0"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  [{finding.type || "finding"}]
                </span>
                <span>{finding.name}</span>
              </div>
            </div>
          ))}
        </CollapsibleSection>

        {/* Decisions Section */}
        <CollapsibleSection
          title="Design Decisions"
          count={counts.decisions}
          expanded={expandedSection === "decisions"}
          onToggle={() => toggleSection("decisions")}
        >
          {decisions.map((decision) => (
            <div
              key={decision.id}
              className="px-3 py-2 text-sm border-b border-border last:border-0"
            >
              <div>
                <span className="font-medium">{decision.name}</span>
                <p className="text-xs text-muted-foreground mt-1 truncate">
                  {decision.decision}
                </p>
              </div>
            </div>
          ))}
        </CollapsibleSection>

        {/* Tasks Section */}
        <CollapsibleSection
          title="Implementation Tasks"
          count={counts.tasks}
          expanded={expandedSection === "tasks"}
          onToggle={() => toggleSection("tasks")}
        >
          {tasks.map((task) => (
            <div
              key={task.id}
              className="px-3 py-2 text-sm border-b border-border last:border-0"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs",
                    getStatusColor(task.status),
                    "text-black"
                  )}
                >
                  {task.status}
                </span>
                <span className="flex-1">{task.name}</span>
              </div>
            </div>
          ))}
        </CollapsibleSection>
      </div>
    </div>
  )
}

// Collapsible section component
function CollapsibleSection({
  title,
  count,
  expanded,
  onToggle,
  children,
}: {
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-border">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-card/50 transition-colors"
      >
        <span className="text-sm font-medium">{title}</span>
        <span className="flex items-center gap-2">
          <span className="px-2 py-0.5 bg-primary/20 text-primary text-xs rounded-full">
            {count}
          </span>
          <span className="text-muted-foreground">{expanded ? "▼" : "▶"}</span>
        </span>
      </button>
      {expanded && count > 0 && (
        <div className="bg-background/50">{children}</div>
      )}
      {expanded && count === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground bg-background/50">
          No {title.toLowerCase()} yet
        </div>
      )}
    </div>
  )
}
