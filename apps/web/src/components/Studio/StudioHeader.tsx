/**
 * StudioHeader - Top header with project selector, feature display, view tabs, and theme toggle
 */

interface StudioHeaderProps {
  feature: any | null
  view: "dashboard" | "schema" | "chat"
  theme: "dark" | "light"
  onViewChange: (view: "dashboard" | "schema" | "chat") => void
  onThemeToggle: () => void
  projects: any[]
  selectedProject: any | null
  onProjectSelect: (id: string) => void
}

export function StudioHeader({
  feature,
  view,
  theme,
  onViewChange,
  onThemeToggle,
  projects,
  selectedProject,
  onProjectSelect,
}: StudioHeaderProps) {
  const tabs = [
    { id: "dashboard" as const, label: "Dashboard" },
    { id: "schema" as const, label: "Schema" },
    { id: "chat" as const, label: "Chat" },
  ]

  // Get tier display info
  const getTierInfo = (tier: string) => {
    switch (tier) {
      case "enterprise":
        return { label: "ENT", className: "tier-enterprise" }
      case "pro":
        return { label: "PRO", className: "tier-pro" }
      case "internal":
        return { label: "INT", className: "tier-internal" }
      default:
        return { label: "STR", className: "tier-starter" }
    }
  }

  // Get status display info
  const getStatusInfo = (status: string) => {
    switch (status) {
      case "active":
        return { color: "#22c55e", title: "Active" }
      case "archived":
        return { color: "#71717a", title: "Archived" }
      default:
        return { color: "#f59e0b", title: "Draft" }
    }
  }

  return (
    <header className="studio-header">
      <style>{headerStyles}</style>

      {/* Left: Project selector and feature info */}
      <div className="header-left">
        <div className="header-project">
          <select
            className="project-selector"
            value={selectedProject?.id || ""}
            onChange={(e) => onProjectSelect(e.target.value)}
          >
            {projects.length === 0 ? (
              <option value="">No projects</option>
            ) : (
              <>
                <option value="" disabled>Select project...</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </>
            )}
          </select>

          {selectedProject && (
            <>
              <span
                className={`tier-badge ${getTierInfo(selectedProject.tier).className}`}
              >
                {getTierInfo(selectedProject.tier).label}
              </span>
              <span
                className="status-indicator"
                style={{ background: getStatusInfo(selectedProject.status).color }}
                title={getStatusInfo(selectedProject.status).title}
              />
            </>
          )}
        </div>

        {feature && (
          <>
            <span className="header-divider">/</span>
            <div className="header-feature">
              <span className="feature-badge">{feature.name}</span>
              <span className={`phase-badge phase-${feature.status}`}>
                {feature.status}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Center: View tabs */}
      <nav className="header-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`header-tab ${view === tab.id ? "active" : ""}`}
            onClick={() => onViewChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Right: Controls */}
      <div className="header-right">
        <button
          className="header-theme-toggle"
          onClick={onThemeToggle}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "\u263e" : "\u2600"}
        </button>
      </div>
    </header>
  )
}

const headerStyles = `
  .studio-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1rem;
    height: 48px;
    background: var(--studio-bg-elevated);
    border-bottom: 1px solid var(--studio-border);
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-project {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .project-selector {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--studio-text);
    background: var(--studio-bg-card);
    border: 1px solid var(--studio-border);
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    min-width: 150px;
  }

  .project-selector:hover {
    border-color: var(--studio-text-muted);
  }

  .project-selector:focus {
    outline: none;
    border-color: var(--studio-accent);
  }

  .tier-badge {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    letter-spacing: 0.05em;
  }

  .tier-enterprise { background: #7c3aed30; color: #a78bfa; }
  .tier-pro { background: #3b82f630; color: #60a5fa; }
  .tier-internal { background: #f59e0b30; color: #fbbf24; }
  .tier-starter { background: #71717a30; color: #a1a1aa; }

  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .header-divider {
    color: var(--studio-text-muted);
    font-size: 0.875rem;
  }

  .header-feature {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .feature-badge {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .phase-badge {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
  }

  .phase-badge.phase-discovery { background: #7c3aed30; color: #a78bfa; }
  .phase-badge.phase-analysis { background: #8b5cf630; color: #c4b5fd; }
  .phase-badge.phase-classification { background: #6366f130; color: #a5b4fc; }
  .phase-badge.phase-design { background: #f59e0b30; color: #fbbf24; }
  .phase-badge.phase-spec { background: #f9731630; color: #fb923c; }
  .phase-badge.phase-testing { background: #ef444430; color: #f87171; }
  .phase-badge.phase-implementation { background: #22c55e30; color: #4ade80; }
  .phase-badge.phase-complete { background: #3b82f630; color: #60a5fa; }

  .header-tabs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .header-tab {
    padding: 0.5rem 1rem;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--studio-text-muted);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .header-tab:hover {
    color: var(--studio-text);
    background: var(--studio-bg-card);
  }

  .header-tab.active {
    color: var(--studio-accent);
    background: var(--studio-bg-card);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-theme-toggle {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--studio-bg-card);
    border: 1px solid var(--studio-border);
    border-radius: 6px;
    color: var(--studio-text-muted);
    font-size: 1rem;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .header-theme-toggle:hover {
    color: var(--studio-text);
    border-color: var(--studio-text-muted);
  }
`
