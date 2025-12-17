/**
 * PlatformFeaturesPage - View platform feature schemas in a readable UI
 *
 * Displays FeatureSessions, Requirements, AnalysisFindings, ImplementationTasks,
 * and other entities with sorting, filtering, and cross-entity navigation.
 */

import { useState, useEffect, useCallback } from "react"
import { mcpService } from "../services/mcpService"
import { SchemaVisualizer, type SchemaModel } from "../components/SchemaVisualizer"

// Types for platform-features schema entities
interface FeatureSession {
  id: string
  name: string
  intent: string
  status: string
  affectedPackages?: string[]
  schemaName?: string
  initialAssessment?: {
    likelyArchetype: string
    indicators: string[]
    uncertainties: string[]
  }
  featureArchetype?: string
  applicablePatterns?: string[]
  createdAt: number
  updatedAt?: number
}

interface Requirement {
  id: string
  session: string
  name: string
  description: string
  priority: string
  status: string
  createdAt?: number
}

interface AnalysisFinding {
  id: string
  session: string
  name: string
  type: string
  description: string
  location: string
  relevantCode?: string
  recommendation?: string
  createdAt: number
}

interface ImplementationTask {
  id: string
  session: string
  name: string
  description: string
  acceptanceCriteria: string[]
  status: string
  createdAt: number
  updatedAt?: number
}

interface DesignDecision {
  id: string
  session: string
  name: string
  question: string
  decision: string
  rationale: string
  createdAt?: number
}

interface IntegrationPoint {
  id: string
  session: string
  name: string
  filePath: string
  package?: string
  targetFunction?: string
  changeType?: string
  description: string
  createdAt: number
}

type EntityType = "FeatureSession" | "Requirement" | "AnalysisFinding" | "ImplementationTask" | "DesignDecision" | "IntegrationPoint"
type SortDirection = "asc" | "desc"

// Styles
const containerStyle: React.CSSProperties = {
  maxWidth: "1400px",
  margin: "0 auto",
  padding: "1.5rem",
  color: "white",
  minHeight: "calc(100vh - 80px)",
}

const headerStyle: React.CSSProperties = {
  marginBottom: "1.5rem",
}

const tabsContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "1rem",
  flexWrap: "wrap",
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.5rem 1rem",
  borderRadius: "4px",
  border: "none",
  background: active ? "#2196f3" : "#333",
  color: "white",
  cursor: "pointer",
  fontWeight: active ? "bold" : "normal",
  fontSize: "0.9rem",
})

const controlsStyle: React.CSSProperties = {
  display: "flex",
  gap: "1rem",
  marginBottom: "1rem",
  flexWrap: "wrap",
  alignItems: "center",
}

const selectStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderRadius: "4px",
  border: "1px solid #444",
  background: "#333",
  color: "white",
  fontSize: "0.9rem",
}

const inputStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderRadius: "4px",
  border: "1px solid #444",
  background: "#333",
  color: "white",
  fontSize: "0.9rem",
  minWidth: "200px",
}

const tableContainerStyle: React.CSSProperties = {
  overflowX: "auto",
  background: "#1e1e1e",
  borderRadius: "8px",
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
}

const thStyle: React.CSSProperties = {
  padding: "0.75rem",
  textAlign: "left",
  background: "#2a2a2a",
  borderBottom: "2px solid #444",
  cursor: "pointer",
  whiteSpace: "nowrap",
  userSelect: "none",
}

const tdStyle: React.CSSProperties = {
  padding: "0.75rem",
  borderBottom: "1px solid #333",
  verticalAlign: "top",
}

const linkStyle: React.CSSProperties = {
  color: "#64b5f6",
  cursor: "pointer",
  textDecoration: "underline",
}

const badgeStyle = (type: string): React.CSSProperties => {
  const colors: Record<string, string> = {
    must: "#f44336",
    should: "#ff9800",
    could: "#4caf50",
    discovery: "#9c27b0",
    analysis: "#2196f3",
    classification: "#00bcd4",
    design: "#ff9800",
    spec: "#4caf50",
    implementation: "#8bc34a",
    completed: "#4caf50",
    proposed: "#9e9e9e",
    in_progress: "#2196f3",
    pending: "#ff9800",
  }
  return {
    display: "inline-block",
    padding: "0.2rem 0.5rem",
    borderRadius: "4px",
    background: colors[type] || "#666",
    color: "white",
    fontSize: "0.8rem",
    fontWeight: "bold",
  }
}

const truncateStyle: React.CSSProperties = {
  maxWidth: "300px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

const expandedTextStyle: React.CSSProperties = {
  maxWidth: "300px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
}

const statsStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.5rem",
  marginBottom: "1rem",
  flexWrap: "wrap",
}

const statCardStyle: React.CSSProperties = {
  padding: "1rem",
  background: "#2a2a2a",
  borderRadius: "8px",
  minWidth: "120px",
}

const loadingStyle: React.CSSProperties = {
  padding: "2rem",
  textAlign: "center",
  color: "#888",
}

const errorStyle: React.CSSProperties = {
  padding: "1rem",
  background: "#ff5252",
  borderRadius: "4px",
  marginBottom: "1rem",
}

// Modal styles for schema visualization
const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0, 0, 0, 0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
}

const modalContentStyle: React.CSSProperties = {
  background: "#1e1e1e",
  borderRadius: "12px",
  width: "90vw",
  maxWidth: "1200px",
  maxHeight: "90vh",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
}

const modalHeaderStyle: React.CSSProperties = {
  padding: "1rem 1.5rem",
  borderBottom: "1px solid #333",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}

const modalBodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1rem",
}

const closeButtonStyle: React.CSSProperties = {
  background: "#444",
  border: "none",
  color: "white",
  padding: "0.5rem 1rem",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "0.9rem",
}

const viewSchemaButtonStyle: React.CSSProperties = {
  background: "#9c27b0",
  border: "none",
  color: "white",
  padding: "0.25rem 0.5rem",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "0.8rem",
  marginRight: "0.5rem",
}

// Utility functions
const formatDate = (timestamp?: number): string => {
  if (!timestamp) return "-"
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const formatShortDate = (timestamp?: number): string => {
  if (!timestamp) return "-"
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

export function PlatformFeaturesPage() {
  // Data state
  const [sessions, setSessions] = useState<FeatureSession[]>([])
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [findings, setFindings] = useState<AnalysisFinding[]>([])
  const [tasks, setTasks] = useState<ImplementationTask[]>([])
  const [decisions, setDecisions] = useState<DesignDecision[]>([])
  const [integrationPoints, setIntegrationPoints] = useState<IntegrationPoint[]>([])

  // UI state
  const [activeTab, setActiveTab] = useState<EntityType>("FeatureSession")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortField, setSortField] = useState<string>("createdAt")
  const [sortDir, setSortDir] = useState<SortDirection>("desc")
  const [sessionFilter, setSessionFilter] = useState<string>("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Schema visualization state
  const [schemaModalOpen, setSchemaModalOpen] = useState(false)
  const [schemaModels, setSchemaModels] = useState<SchemaModel[]>([])
  const [selectedSchemaName, setSelectedSchemaName] = useState<string>("")
  const [schemaLoading, setSchemaLoading] = useState(false)

  // Load data on mount
  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    setError(null)

    try {
      // Initialize MCP session
      await mcpService.initializeSession()

      // Load schema
      await mcpService.loadSchema("platform-features")

      // Fetch all collections in parallel
      const [
        sessionsData,
        requirementsData,
        findingsData,
        tasksData,
        decisionsData,
        integrationPointsData,
      ] = await Promise.all([
        mcpService.callTool("store.list", { schema: "platform-features", model: "FeatureSession" }),
        mcpService.callTool("store.list", { schema: "platform-features", model: "Requirement" }),
        mcpService.callTool("store.list", { schema: "platform-features", model: "AnalysisFinding" }),
        mcpService.callTool("store.list", { schema: "platform-features", model: "ImplementationTask" }),
        mcpService.callTool("store.list", { schema: "platform-features", model: "DesignDecision" }),
        mcpService.callTool("store.list", { schema: "platform-features", model: "IntegrationPoint" }),
      ])

      setSessions(sessionsData.items || [])
      setRequirements(requirementsData.items || [])
      setFindings(findingsData.items || [])
      setTasks(tasksData.items || [])
      setDecisions(decisionsData.items || [])
      setIntegrationPoints(integrationPointsData.items || [])
    } catch (err: any) {
      setError(err.message || "Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  // Load and view a domain schema
  const viewSchema = async (schemaName: string) => {
    setSchemaLoading(true)
    setSelectedSchemaName(schemaName)
    setSchemaModalOpen(true)

    try {
      // Load the schema to get model definitions
      const schemaResult = await mcpService.loadSchema(schemaName)

      if (schemaResult.ok && schemaResult.models) {
        setSchemaModels(schemaResult.models)
      } else {
        setError(`Failed to load schema: ${schemaName}`)
      }
    } catch (err: any) {
      setError(err.message || `Failed to load schema: ${schemaName}`)
    } finally {
      setSchemaLoading(false)
    }
  }

  // Close schema modal
  const closeSchemaModal = () => {
    setSchemaModalOpen(false)
    setSchemaModels([])
    setSelectedSchemaName("")
  }

  // Toggle row expansion
  const toggleExpand = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Navigate to session and filter by it
  const navigateToSession = (sessionId: string) => {
    setSessionFilter(sessionId)
    setActiveTab("Requirement")
  }

  // Sort handler
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDir("desc")
    }
  }

  // Generic sort function
  const sortItems = <T extends Record<string, any>>(items: T[]): T[] => {
    return [...items].sort((a, b) => {
      const aVal = a[sortField]
      const bVal = b[sortField]

      if (aVal === undefined || aVal === null) return 1
      if (bVal === undefined || bVal === null) return -1

      let comparison = 0
      if (typeof aVal === "string") {
        comparison = aVal.localeCompare(bVal)
      } else if (typeof aVal === "number") {
        comparison = aVal - bVal
      }

      return sortDir === "asc" ? comparison : -comparison
    })
  }

  // Filter function
  const filterItems = <T extends { session?: string; status?: string; name?: string; description?: string }>(items: T[]): T[] => {
    return items.filter(item => {
      if (sessionFilter && item.session !== sessionFilter) return false
      if (statusFilter && item.status !== statusFilter) return false
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const name = (item.name || "").toLowerCase()
        const desc = (item.description || "").toLowerCase()
        if (!name.includes(query) && !desc.includes(query)) return false
      }
      return true
    })
  }

  // Get session name by ID
  const getSessionName = (sessionId: string): string => {
    const session = sessions.find(s => s.id === sessionId)
    return session?.name || sessionId
  }

  // Render sort indicator
  const SortIndicator = ({ field }: { field: string }) => {
    if (sortField !== field) return <span style={{ opacity: 0.3 }}> ↕</span>
    return <span> {sortDir === "asc" ? "↑" : "↓"}</span>
  }

  // Render table header
  const renderTh = (label: string, field: string) => (
    <th style={thStyle} onClick={() => handleSort(field)}>
      {label}<SortIndicator field={field} />
    </th>
  )

  // Get unique statuses for current tab
  const getStatusOptions = (): string[] => {
    let items: { status?: string }[] = []
    switch (activeTab) {
      case "FeatureSession": items = sessions; break
      case "Requirement": items = requirements; break
      case "ImplementationTask": items = tasks; break
      default: return []
    }
    const statuses = new Set(items.map(i => i.status).filter(Boolean))
    return Array.from(statuses) as string[]
  }

  // Render FeatureSessions table
  const renderSessionsTable = () => {
    const filtered = sortItems(
      sessions.filter(s => {
        if (searchQuery) {
          const query = searchQuery.toLowerCase()
          return s.name.toLowerCase().includes(query) || s.intent.toLowerCase().includes(query)
        }
        if (statusFilter && s.status !== statusFilter) return false
        return true
      })
    )

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            {renderTh("Status", "status")}
            <th style={thStyle}>Intent</th>
            <th style={thStyle}>Archetype</th>
            <th style={thStyle}>Packages</th>
            {renderTh("Created", "createdAt")}
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(session => (
            <tr key={session.id}>
              <td style={tdStyle}>
                <strong>{session.name}</strong>
                <div style={{ fontSize: "0.8rem", color: "#888" }}>{session.id.slice(0, 8)}...</div>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(session.status)}>{session.status}</span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(session.id) ? expandedTextStyle : truncateStyle) }}>
                <span
                  onClick={() => toggleExpand(session.id)}
                  style={{ cursor: "pointer" }}
                  title="Click to expand"
                >
                  {session.intent}
                </span>
              </td>
              <td style={tdStyle}>
                {session.featureArchetype || session.initialAssessment?.likelyArchetype || "-"}
              </td>
              <td style={tdStyle}>
                {session.affectedPackages?.join(", ") || "-"}
              </td>
              <td style={tdStyle}>{formatShortDate(session.createdAt)}</td>
              <td style={tdStyle}>
                {session.schemaName && (
                  <button
                    style={viewSchemaButtonStyle}
                    onClick={() => viewSchema(session.schemaName!)}
                    title={`View ${session.schemaName} schema`}
                  >
                    View Schema
                  </button>
                )}
                <span style={linkStyle} onClick={() => navigateToSession(session.id)}>
                  View Related →
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render Requirements table
  const renderRequirementsTable = () => {
    const filtered = sortItems(filterItems(requirements))

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            {renderTh("Priority", "priority")}
            {renderTh("Status", "status")}
            <th style={thStyle}>Description</th>
            <th style={thStyle}>Session</th>
            {renderTh("Created", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {filtered.map(req => (
            <tr key={req.id}>
              <td style={tdStyle}>
                <strong>{req.name}</strong>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(req.priority)}>{req.priority}</span>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(req.status)}>{req.status}</span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(req.id) ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(req.id)} style={{ cursor: "pointer" }}>
                  {req.description}
                </span>
              </td>
              <td style={tdStyle}>
                <span style={linkStyle} onClick={() => { setSessionFilter(req.session); setActiveTab("FeatureSession") }}>
                  {getSessionName(req.session)}
                </span>
              </td>
              <td style={tdStyle}>{formatShortDate(req.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render AnalysisFindings table
  const renderFindingsTable = () => {
    const filtered = sortItems(filterItems(findings))

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            {renderTh("Type", "type")}
            <th style={thStyle}>Description</th>
            <th style={thStyle}>Location</th>
            <th style={thStyle}>Session</th>
            {renderTh("Created", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {filtered.map(finding => (
            <tr key={finding.id}>
              <td style={tdStyle}>
                <strong>{finding.name}</strong>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(finding.type)}>{finding.type}</span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(finding.id) ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(finding.id)} style={{ cursor: "pointer" }}>
                  {finding.description}
                </span>
              </td>
              <td style={tdStyle}>
                <code style={{ fontSize: "0.85rem", color: "#aaa" }}>{finding.location}</code>
              </td>
              <td style={tdStyle}>
                <span style={linkStyle} onClick={() => { setSessionFilter(finding.session); setActiveTab("FeatureSession") }}>
                  {getSessionName(finding.session)}
                </span>
              </td>
              <td style={tdStyle}>{formatShortDate(finding.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render ImplementationTasks table
  const renderTasksTable = () => {
    const filtered = sortItems(filterItems(tasks))

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            {renderTh("Status", "status")}
            <th style={thStyle}>Description</th>
            <th style={thStyle}>Acceptance Criteria</th>
            <th style={thStyle}>Session</th>
            {renderTh("Created", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {filtered.map(task => (
            <tr key={task.id}>
              <td style={tdStyle}>
                <strong>{task.name}</strong>
              </td>
              <td style={tdStyle}>
                <span style={badgeStyle(task.status)}>{task.status}</span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(task.id) ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(task.id)} style={{ cursor: "pointer" }}>
                  {task.description}
                </span>
              </td>
              <td style={tdStyle}>
                {task.acceptanceCriteria?.length || 0} criteria
                {expandedRows.has(task.id + "-ac") && (
                  <ul style={{ margin: "0.5rem 0", paddingLeft: "1.2rem" }}>
                    {task.acceptanceCriteria?.map((ac, i) => <li key={i}>{ac}</li>)}
                  </ul>
                )}
                {task.acceptanceCriteria?.length > 0 && (
                  <span
                    style={{ ...linkStyle, marginLeft: "0.5rem", fontSize: "0.8rem" }}
                    onClick={() => toggleExpand(task.id + "-ac")}
                  >
                    {expandedRows.has(task.id + "-ac") ? "hide" : "show"}
                  </span>
                )}
              </td>
              <td style={tdStyle}>
                <span style={linkStyle} onClick={() => { setSessionFilter(task.session); setActiveTab("FeatureSession") }}>
                  {getSessionName(task.session)}
                </span>
              </td>
              <td style={tdStyle}>{formatShortDate(task.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render DesignDecisions table
  const renderDecisionsTable = () => {
    const filtered = sortItems(filterItems(decisions))

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            <th style={thStyle}>Question</th>
            <th style={thStyle}>Decision</th>
            <th style={thStyle}>Rationale</th>
            <th style={thStyle}>Session</th>
            {renderTh("Created", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {filtered.map(decision => (
            <tr key={decision.id}>
              <td style={tdStyle}>
                <strong>{decision.name}</strong>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(decision.id + "-q") ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(decision.id + "-q")} style={{ cursor: "pointer" }}>
                  {decision.question}
                </span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(decision.id + "-d") ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(decision.id + "-d")} style={{ cursor: "pointer" }}>
                  {decision.decision}
                </span>
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(decision.id + "-r") ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(decision.id + "-r")} style={{ cursor: "pointer" }}>
                  {decision.rationale}
                </span>
              </td>
              <td style={tdStyle}>
                <span style={linkStyle} onClick={() => { setSessionFilter(decision.session); setActiveTab("FeatureSession") }}>
                  {getSessionName(decision.session)}
                </span>
              </td>
              <td style={tdStyle}>{formatShortDate(decision.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render IntegrationPoints table
  const renderIntegrationPointsTable = () => {
    const filtered = sortItems(filterItems(integrationPoints))

    return (
      <table style={tableStyle}>
        <thead>
          <tr>
            {renderTh("Name", "name")}
            <th style={thStyle}>File Path</th>
            <th style={thStyle}>Package</th>
            <th style={thStyle}>Change Type</th>
            <th style={thStyle}>Description</th>
            <th style={thStyle}>Session</th>
            {renderTh("Created", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {filtered.map(ip => (
            <tr key={ip.id}>
              <td style={tdStyle}>
                <strong>{ip.name}</strong>
              </td>
              <td style={tdStyle}>
                <code style={{ fontSize: "0.85rem", color: "#aaa" }}>{ip.filePath}</code>
              </td>
              <td style={tdStyle}>{ip.package || "-"}</td>
              <td style={tdStyle}>
                {ip.changeType && <span style={badgeStyle(ip.changeType)}>{ip.changeType}</span>}
              </td>
              <td style={{ ...tdStyle, ...(expandedRows.has(ip.id) ? expandedTextStyle : truncateStyle) }}>
                <span onClick={() => toggleExpand(ip.id)} style={{ cursor: "pointer" }}>
                  {ip.description}
                </span>
              </td>
              <td style={tdStyle}>
                <span style={linkStyle} onClick={() => { setSessionFilter(ip.session); setActiveTab("FeatureSession") }}>
                  {getSessionName(ip.session)}
                </span>
              </td>
              <td style={tdStyle}>{formatShortDate(ip.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // Render current tab content
  const renderTable = () => {
    switch (activeTab) {
      case "FeatureSession": return renderSessionsTable()
      case "Requirement": return renderRequirementsTable()
      case "AnalysisFinding": return renderFindingsTable()
      case "ImplementationTask": return renderTasksTable()
      case "DesignDecision": return renderDecisionsTable()
      case "IntegrationPoint": return renderIntegrationPointsTable()
    }
  }

  // Get count for tab
  const getCount = (type: EntityType): number => {
    switch (type) {
      case "FeatureSession": return sessions.length
      case "Requirement": return requirements.length
      case "AnalysisFinding": return findings.length
      case "ImplementationTask": return tasks.length
      case "DesignDecision": return decisions.length
      case "IntegrationPoint": return integrationPoints.length
    }
  }

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingStyle}>Loading platform features data...</div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ margin: 0 }}>Platform Features</h1>
            <p style={{ margin: "0.5rem 0 0 0", color: "#888" }}>
              Browse feature sessions, requirements, findings, and implementation tasks
            </p>
          </div>
          <button
            style={{ ...viewSchemaButtonStyle, padding: "0.5rem 1rem", fontSize: "0.9rem" }}
            onClick={() => viewSchema("platform-features")}
          >
            View Platform Schema
          </button>
        </div>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {/* Stats */}
      <div style={statsStyle}>
        <div style={statCardStyle}>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{sessions.length}</div>
          <div style={{ color: "#888", fontSize: "0.9rem" }}>Sessions</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{requirements.length}</div>
          <div style={{ color: "#888", fontSize: "0.9rem" }}>Requirements</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{findings.length}</div>
          <div style={{ color: "#888", fontSize: "0.9rem" }}>Findings</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{tasks.length}</div>
          <div style={{ color: "#888", fontSize: "0.9rem" }}>Tasks</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={tabsContainerStyle}>
        {(["FeatureSession", "Requirement", "AnalysisFinding", "ImplementationTask", "DesignDecision", "IntegrationPoint"] as EntityType[]).map(type => (
          <button
            key={type}
            style={tabStyle(activeTab === type)}
            onClick={() => { setActiveTab(type); setStatusFilter(""); }}
          >
            {type.replace(/([A-Z])/g, " $1").trim()}s ({getCount(type)})
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={controlsStyle}>
        <input
          type="text"
          placeholder="Search by name or description..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={inputStyle}
        />

        {activeTab !== "FeatureSession" && (
          <select
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Sessions</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {getStatusOptions().length > 0 && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Statuses</option>
            {getStatusOptions().map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}

        {(sessionFilter || statusFilter || searchQuery) && (
          <button
            style={{ ...selectStyle, cursor: "pointer", background: "#444" }}
            onClick={() => { setSessionFilter(""); setStatusFilter(""); setSearchQuery(""); }}
          >
            Clear Filters
          </button>
        )}

        <button
          style={{ ...selectStyle, cursor: "pointer", marginLeft: "auto" }}
          onClick={loadData}
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      <div style={tableContainerStyle}>
        {renderTable()}
      </div>

      {/* Schema Visualization Modal */}
      {schemaModalOpen && (
        <div style={modalOverlayStyle} onClick={closeSchemaModal}>
          <div style={modalContentStyle} onClick={e => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
                  Schema: {selectedSchemaName}
                </h2>
                <p style={{ margin: "0.25rem 0 0 0", color: "#888", fontSize: "0.9rem" }}>
                  Domain model visualization
                </p>
              </div>
              <button style={closeButtonStyle} onClick={closeSchemaModal}>
                Close
              </button>
            </div>
            <div style={modalBodyStyle}>
              {schemaLoading ? (
                <div style={loadingStyle}>Loading schema...</div>
              ) : schemaModels.length > 0 ? (
                <SchemaVisualizer
                  models={schemaModels}
                  schemaName={selectedSchemaName}
                />
              ) : (
                <div style={loadingStyle}>No models found in schema</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
