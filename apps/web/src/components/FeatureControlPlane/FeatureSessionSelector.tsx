/**
 * FeatureSessionSelector - Dropdown to select/create feature sessions
 *
 * Fetches FeatureSessions from platform-features schema and allows:
 * - Selecting existing sessions
 * - Creating new sessions (triggers discovery skill)
 */

import { useState, useEffect, useCallback } from "react"
import { mcpService } from "@/services"

interface FeatureSession {
  id: string
  name: string
  intent: string // Schema uses "intent" not "description"
  status: string // This IS the current phase (discovery, analysis, etc.)
  createdAt: number
}

interface FeatureSessionSelectorProps {
  selectedSessionId: string | null
  onSessionSelect: (session: FeatureSession | null) => void
  onCreateNew: () => void
}

export function FeatureSessionSelector({
  selectedSessionId,
  onSessionSelect,
  onCreateNew,
}: FeatureSessionSelectorProps) {
  const [sessions, setSessions] = useState<FeatureSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      // Load schema first
      await mcpService.callTool("schema.load", { name: "platform-features" })

      // Query all feature sessions
      const result = await mcpService.callTool("store.query", {
        schema: "platform-features",
        model: "FeatureSession",
      })

      setSessions(result.items || [])
    } catch (err: any) {
      console.error("[FeatureSessionSelector] Error loading sessions:", err)
      setError(err.message || "Failed to load sessions")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Poll for updates every 30 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 30000)
    return () => clearInterval(interval)
  }, [loadSessions])

  const selectedSession = sessions.find((s) => s.id === selectedSessionId)

  const getStatusColor = (status: string) => {
    switch (status) {
      case "complete":
        return "bg-green-400"
      case "implementation":
      case "testing":
        return "bg-blue-400"
      case "discovery":
      case "analysis":
      case "classification":
      case "design":
      case "spec":
        return "bg-yellow-400"
      default:
        return "bg-muted"
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-card border-b border-border">
      <label className="text-sm font-medium text-muted-foreground">
        Feature Session:
      </label>

      {loading && sessions.length === 0 ? (
        <span className="text-sm text-muted-foreground">Loading...</span>
      ) : error ? (
        <span className="text-sm text-red-400">{error}</span>
      ) : (
        <>
          <select
            value={selectedSessionId || ""}
            onChange={(e) => {
              const session = sessions.find((s) => s.id === e.target.value)
              onSessionSelect(session || null)
            }}
            className="flex-1 max-w-md px-3 py-1.5 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Select a feature session...</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} ({session.status})
              </option>
            ))}
          </select>

          {selectedSession && (
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusColor(
                selectedSession.status
              )} text-black`}
            >
              {selectedSession.status}
            </span>
          )}

          <button
            onClick={onCreateNew}
            className="px-3 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
          >
            + New Feature
          </button>
        </>
      )}
    </div>
  )
}
