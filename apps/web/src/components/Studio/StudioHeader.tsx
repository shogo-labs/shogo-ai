/**
 * StudioHeader - Top header with feature selector, view tabs, and theme toggle
 */

interface StudioHeaderProps {
  feature: any | null
  view: "dashboard" | "schema" | "chat"
  theme: "dark" | "light"
  onViewChange: (view: "dashboard" | "schema" | "chat") => void
  onThemeToggle: () => void
}

export function StudioHeader({
  feature,
  view,
  theme,
  onViewChange,
  onThemeToggle,
}: StudioHeaderProps) {
  const tabs = [
    { id: "dashboard" as const, label: "Dashboard" },
    { id: "schema" as const, label: "Schema" },
    { id: "chat" as const, label: "Chat" },
  ]

  return (
    <header className="studio-header">
      <style>{headerStyles}</style>

      {/* Left: Feature info */}
      <div className="header-left">
        <div className="header-project">
          <span className="project-badge">shogo-platform</span>
        </div>

        {feature && (
          <>
            <span className="header-divider">/</span>
            <div className="header-feature">
              <span className="feature-badge">{feature.name}</span>
              <span className={`phase-badge phase-${feature.phase}`}>
                {feature.phase}
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
  }

  .project-badge {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--studio-text-muted);
    background: var(--studio-bg-card);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
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
  .phase-badge.phase-design { background: #f59e0b30; color: #fbbf24; }
  .phase-badge.phase-build { background: #22c55e30; color: #4ade80; }
  .phase-badge.phase-deploy { background: #3b82f630; color: #60a5fa; }

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
