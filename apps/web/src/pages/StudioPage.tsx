/**
 * StudioPage - Internal developer studio for platform feature development
 *
 * Provides a unified experience for:
 * - Feature navigation (sidebar with search and grouping)
 * - Dashboard view (stats and activity for selected feature)
 * - Schema visualization (ReactFlow for feature's schema)
 * - Chat integration (AI SDK conversation linked to feature)
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useParams, useNavigate, useSearchParams, Outlet } from "react-router-dom"
import { observer } from "mobx-react-lite"
import { useDomains } from "../contexts/DomainProvider"
import { StudioLayout } from "../components/Studio/StudioLayout"
import { FeatureSidebar } from "../components/Studio/FeatureSidebar"
import { StudioHeader } from "../components/Studio/StudioHeader"
import { DashboardView } from "../components/Studio/DashboardView"
import { SchemaView } from "../components/Studio/SchemaView"
import { ChatView } from "../components/Studio/ChatView"
import { NewFeatureModal } from "../components/Studio/NewFeatureModal"

// Types
type StudioView = "dashboard" | "schema" | "chat"

interface StudioPreferences {
  theme: "dark" | "light"
  sidebarCollapsed: boolean
  sidebarWidth: number
}

// Default preferences
const defaultPreferences: StudioPreferences = {
  theme: "dark",
  sidebarCollapsed: false,
  sidebarWidth: 280,
}

// Local storage key
const PREFS_KEY = "studio-preferences"

// Load preferences from localStorage
function loadPreferences(): StudioPreferences {
  try {
    const stored = localStorage.getItem(PREFS_KEY)
    if (stored) {
      return { ...defaultPreferences, ...JSON.parse(stored) }
    }
  } catch (e) {
    console.warn("[StudioPage] Failed to load preferences:", e)
  }
  return defaultPreferences
}

// Save preferences to localStorage
function savePreferences(prefs: StudioPreferences) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch (e) {
    console.warn("[StudioPage] Failed to save preferences:", e)
  }
}

export const StudioPage = observer(function StudioPage() {
  const domains = useDomains()
  const { platformFeatures, chat, studioCore } = domains
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // URL-based state
  const projectId = searchParams.get("project")
  const featureId = searchParams.get("feature")
  const view = (searchParams.get("view") as StudioView) || "dashboard"

  // Local UI state
  const [preferences, setPreferences] = useState<StudioPreferences>(loadPreferences)
  const [searchQuery, setSearchQuery] = useState("")
  const [isNewFeatureModalOpen, setIsNewFeatureModalOpen] = useState(false)

  // Get all projects
  const allProjects = studioCore.projectCollection.all()

  // Get selected project
  const selectedProject = projectId
    ? studioCore.projectCollection.get(projectId)
    : null

  // Get features filtered by selected project
  const allFeatures = projectId
    ? platformFeatures.featureSessionCollection.findByProject(projectId)
    : []

  // Group features by phase
  const groupedFeatures = useMemo(() => {
    const filtered = searchQuery
      ? allFeatures.filter((f: any) =>
          f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          f.intent.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : allFeatures

    return {
      inProgress: filtered.filter((f: any) =>
        ["analysis", "classification", "design", "spec", "implementation", "testing"].includes(f.status)
      ),
      discovery: filtered.filter((f: any) => f.status === "discovery"),
      completed: filtered.filter((f: any) => f.status === "complete"),
    }
  }, [allFeatures, searchQuery])

  // Get selected feature
  const selectedFeature = featureId
    ? platformFeatures.featureSessionCollection.get(featureId)
    : null

  // Get linked chat session (if any)
  const linkedChatSession = selectedFeature
    ? chat.chatSessionCollection.findByFeatureSessionId(selectedFeature.id)
    : null

  // Handle project selection
  const handleProjectSelect = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams)
    params.set("project", id)
    // Clear feature selection when project changes (feature may not belong to new project)
    params.delete("feature")
    navigate(`/studio?${params.toString()}`)
  }, [navigate, searchParams])

  // Handle feature selection
  const handleFeatureSelect = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams)
    params.set("feature", id)
    navigate(`/studio?${params.toString()}`)
  }, [navigate, searchParams])

  // Handle view change
  const handleViewChange = useCallback((newView: StudioView) => {
    const params = new URLSearchParams(searchParams)
    params.set("view", newView)
    navigate(`/studio?${params.toString()}`)
  }, [navigate, searchParams])

  // Handle preference changes
  const updatePreferences = useCallback((updates: Partial<StudioPreferences>) => {
    setPreferences((prev) => {
      const next = { ...prev, ...updates }
      savePreferences(next)
      return next
    })
  }, [])

  // Toggle theme
  const toggleTheme = useCallback(() => {
    updatePreferences({ theme: preferences.theme === "dark" ? "light" : "dark" })
  }, [preferences.theme, updatePreferences])

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    updatePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed })
  }, [preferences.sidebarCollapsed, updatePreferences])

  // Handle sidebar resize
  const handleSidebarResize = useCallback((width: number) => {
    updatePreferences({ sidebarWidth: width })
  }, [updatePreferences])

  // Handle new feature modal
  const handleNewFeature = useCallback(() => {
    setIsNewFeatureModalOpen(true)
  }, [])

  const handleNewFeatureClose = useCallback(() => {
    setIsNewFeatureModalOpen(false)
  }, [])

  const handleFeatureCreated = useCallback((feature: any) => {
    // Select the newly created feature
    handleFeatureSelect(feature.id)
  }, [handleFeatureSelect])

  // Auto-select first project if none selected
  useEffect(() => {
    if (!projectId && allProjects.length > 0) {
      handleProjectSelect(allProjects[0].id)
    }
  }, [projectId, allProjects, handleProjectSelect])

  // Auto-select first feature if none selected (only when project is selected)
  useEffect(() => {
    if (projectId && !featureId && allFeatures.length > 0) {
      // Prefer in-progress, then discovery, then completed
      const first =
        groupedFeatures.inProgress[0] ||
        groupedFeatures.discovery[0] ||
        groupedFeatures.completed[0]
      if (first) {
        handleFeatureSelect(first.id)
      }
    }
  }, [projectId, featureId, allFeatures, groupedFeatures, handleFeatureSelect])

  // Apply theme class to document
  useEffect(() => {
    document.documentElement.setAttribute("data-studio-theme", preferences.theme)
    return () => {
      document.documentElement.removeAttribute("data-studio-theme")
    }
  }, [preferences.theme])

  // Render current view
  const renderView = () => {
    // No projects exist
    if (allProjects.length === 0) {
      return (
        <div className="studio-empty-state">
          <h2>No Projects</h2>
          <p>Create a project first to start building features.</p>
          <a
            href="/studio-core-demo"
            className="studio-link"
          >
            Go to Studio Core Demo to create a project
          </a>
        </div>
      )
    }

    // No project selected
    if (!selectedProject) {
      return (
        <div className="studio-empty-state">
          <h2>Select a Project</h2>
          <p>Choose a project from the dropdown above to view its features.</p>
        </div>
      )
    }

    // No feature selected
    if (!selectedFeature) {
      return (
        <div className="studio-empty-state">
          <h2>No Feature Selected</h2>
          <p>Select a feature from the sidebar or create a new one.</p>
        </div>
      )
    }

    switch (view) {
      case "dashboard":
        return (
          <DashboardView
            feature={selectedFeature}
            platformFeatures={platformFeatures}
          />
        )
      case "schema":
        return (
          <SchemaView
            feature={selectedFeature}
          />
        )
      case "chat":
        return (
          <ChatView
            feature={selectedFeature}
            chatSession={linkedChatSession}
            chat={chat}
          />
        )
      default:
        return null
    }
  }

  return (
    <div
      className="studio-container"
      data-theme={preferences.theme}
    >
      <style>{studioStyles}</style>

      <StudioHeader
        feature={selectedFeature}
        view={view}
        theme={preferences.theme}
        onViewChange={handleViewChange}
        onThemeToggle={toggleTheme}
        projects={allProjects}
        selectedProject={selectedProject}
        onProjectSelect={handleProjectSelect}
      />

      <StudioLayout
        sidebarCollapsed={preferences.sidebarCollapsed}
        sidebarWidth={preferences.sidebarWidth}
        onSidebarToggle={toggleSidebar}
        onSidebarResize={handleSidebarResize}
        sidebar={
          <FeatureSidebar
            features={groupedFeatures}
            selectedId={featureId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onFeatureSelect={handleFeatureSelect}
            onNewFeature={handleNewFeature}
            selectedProjectId={projectId}
          />
        }
      >
        {renderView()}
      </StudioLayout>

      {/* New Feature Modal */}
      {projectId && (
        <NewFeatureModal
          isOpen={isNewFeatureModalOpen}
          onClose={handleNewFeatureClose}
          projectId={projectId}
          onFeatureCreated={handleFeatureCreated}
          domains={domains}
        />
      )}
    </div>
  )
})

// Inline styles for Studio (will be refined with theme system)
const studioStyles = `
  .studio-container {
    --studio-bg-base: #09090b;
    --studio-bg-elevated: #18181b;
    --studio-bg-card: #27272a;
    --studio-border: #3f3f46;
    --studio-text: #fafafa;
    --studio-text-muted: #a1a1aa;
    --studio-accent: #3b82f6;
    --studio-accent-hover: #2563eb;
    --studio-success: #22c55e;
    --studio-warning: #f59e0b;
    --studio-error: #ef4444;

    display: flex;
    flex-direction: column;
    height: calc(100vh - 60px);
    background: var(--studio-bg-base);
    color: var(--studio-text);
    font-family: system-ui, -apple-system, sans-serif;
  }

  .studio-container[data-theme="light"] {
    --studio-bg-base: #fafafa;
    --studio-bg-elevated: #ffffff;
    --studio-bg-card: #ffffff;
    --studio-border: #e4e4e7;
    --studio-text: #18181b;
    --studio-text-muted: #71717a;
  }

  .studio-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--studio-text-muted);
    text-align: center;
    padding: 2rem;
  }

  .studio-empty-state h2 {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .studio-empty-state p {
    margin: 0;
    font-size: 0.875rem;
  }

  .studio-link {
    display: inline-block;
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background: var(--studio-accent);
    color: white;
    text-decoration: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.2s;
  }

  .studio-link:hover {
    background: var(--studio-accent-hover);
  }
`
