/**
 * FeatureSidebar - Feature list with search and status grouping
 *
 * Features:
 * - Search/filter by name or intent
 * - Grouped by status: In Progress, Discovery, Completed
 * - Collapsible groups
 * - Current feature highlighted
 * - Quick stats per feature
 */

import { useState } from "react"

interface FeatureGroup {
  inProgress: any[]
  discovery: any[]
  completed: any[]
}

interface FeatureSidebarProps {
  features: FeatureGroup
  selectedId: string | null
  searchQuery: string
  onSearchChange: (query: string) => void
  onFeatureSelect: (id: string) => void
}

export function FeatureSidebar({
  features,
  selectedId,
  searchQuery,
  onSearchChange,
  onFeatureSelect,
}: FeatureSidebarProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(["inProgress", "discovery"])
  )

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  const renderFeatureItem = (feature: any) => {
    const isSelected = feature.id === selectedId

    return (
      <button
        key={feature.id}
        className={`sidebar-feature-item ${isSelected ? "selected" : ""}`}
        onClick={() => onFeatureSelect(feature.id)}
      >
        <div className="feature-item-header">
          <span className="feature-name">{feature.name}</span>
          <span className={`feature-status status-${feature.status}`}>
            {feature.status}
          </span>
        </div>
        <div className="feature-meta">
          <span className="feature-stat">
            {feature.requirementCount || 0} reqs
          </span>
          <span className="feature-stat">
            {feature.taskCount || 0} tasks
          </span>
          {feature.completionProgress > 0 && (
            <span className="feature-progress">
              {feature.completionProgress}%
            </span>
          )}
        </div>
      </button>
    )
  }

  const renderGroup = (
    key: string,
    label: string,
    items: any[],
    emptyMessage: string
  ) => {
    const isExpanded = expandedGroups.has(key)
    const count = items.length

    return (
      <div className="sidebar-group" key={key}>
        <button
          className="sidebar-group-header"
          onClick={() => toggleGroup(key)}
        >
          <span className="group-toggle">{isExpanded ? "v" : ">"}</span>
          <span className="group-label">{label}</span>
          <span className="group-count">{count}</span>
        </button>

        {isExpanded && (
          <div className="sidebar-group-content">
            {items.length === 0 ? (
              <div className="sidebar-empty">{emptyMessage}</div>
            ) : (
              items.map(renderFeatureItem)
            )}
          </div>
        )}
      </div>
    )
  }

  const totalCount =
    features.inProgress.length +
    features.discovery.length +
    features.completed.length

  return (
    <div className="feature-sidebar">
      <style>{sidebarStyles}</style>

      {/* Header */}
      <div className="sidebar-header">
        <h2 className="sidebar-title">Features</h2>
        <span className="sidebar-count">{totalCount}</span>
      </div>

      {/* Search */}
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search features..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="sidebar-search-input"
        />
        {searchQuery && (
          <button
            className="sidebar-search-clear"
            onClick={() => onSearchChange("")}
          >
            x
          </button>
        )}
      </div>

      {/* Feature groups */}
      <div className="sidebar-groups">
        {renderGroup(
          "inProgress",
          "In Progress",
          features.inProgress,
          "No features in progress"
        )}
        {renderGroup(
          "discovery",
          "Discovery",
          features.discovery,
          "No features in discovery"
        )}
        {renderGroup(
          "completed",
          "Completed",
          features.completed,
          "No completed features"
        )}
      </div>

      {/* New feature button */}
      <div className="sidebar-footer">
        <button className="sidebar-new-btn" disabled>
          + New Feature
        </button>
      </div>
    </div>
  )
}

const sidebarStyles = `
  .feature-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    border-bottom: 1px solid var(--studio-border);
  }

  .sidebar-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .sidebar-count {
    font-size: 0.75rem;
    color: var(--studio-text-muted);
    background: var(--studio-bg-card);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
  }

  .sidebar-search {
    padding: 0.5rem 1rem;
    position: relative;
  }

  .sidebar-search-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    background: var(--studio-bg-card);
    border: 1px solid var(--studio-border);
    border-radius: 6px;
    color: var(--studio-text);
    outline: none;
    transition: border-color 0.15s ease;
  }

  .sidebar-search-input:focus {
    border-color: var(--studio-accent);
  }

  .sidebar-search-input::placeholder {
    color: var(--studio-text-muted);
  }

  .sidebar-search-clear {
    position: absolute;
    right: 1.5rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--studio-text-muted);
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0.25rem;
  }

  .sidebar-search-clear:hover {
    color: var(--studio-text);
  }

  .sidebar-groups {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .sidebar-group {
    margin-bottom: 0.25rem;
  }

  .sidebar-group-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    color: var(--studio-text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: color 0.15s ease;
  }

  .sidebar-group-header:hover {
    color: var(--studio-text);
  }

  .group-toggle {
    font-size: 0.625rem;
    width: 0.75rem;
  }

  .group-label {
    flex: 1;
    text-align: left;
  }

  .group-count {
    font-weight: 400;
  }

  .sidebar-group-content {
    padding: 0 0.5rem;
  }

  .sidebar-empty {
    padding: 0.5rem;
    font-size: 0.75rem;
    color: var(--studio-text-muted);
    text-align: center;
  }

  .sidebar-feature-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--studio-text);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease, border-color 0.15s ease;
    margin-bottom: 0.25rem;
  }

  .sidebar-feature-item:hover {
    background: var(--studio-bg-card);
  }

  .sidebar-feature-item.selected {
    background: var(--studio-bg-card);
    border-color: var(--studio-accent);
  }

  .feature-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .feature-name {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feature-status {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    background: var(--studio-bg-elevated);
    color: var(--studio-text-muted);
  }

  .feature-status.status-discovery { background: #7c3aed20; color: #a78bfa; }
  .feature-status.status-analysis { background: #3b82f620; color: #60a5fa; }
  .feature-status.status-classification { background: #06b6d420; color: #22d3ee; }
  .feature-status.status-design { background: #f59e0b20; color: #fbbf24; }
  .feature-status.status-spec { background: #10b98120; color: #34d399; }
  .feature-status.status-implementation { background: #22c55e20; color: #4ade80; }
  .feature-status.status-testing { background: #84cc1620; color: #a3e635; }
  .feature-status.status-complete { background: #22c55e20; color: #22c55e; }

  .feature-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: var(--studio-text-muted);
  }

  .feature-stat {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .feature-progress {
    color: var(--studio-accent);
    font-weight: 500;
  }

  .sidebar-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--studio-border);
  }

  .sidebar-new-btn {
    width: 100%;
    padding: 0.5rem;
    background: var(--studio-bg-card);
    border: 1px dashed var(--studio-border);
    border-radius: 6px;
    color: var(--studio-text-muted);
    font-size: 0.875rem;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .sidebar-new-btn:hover:not(:disabled) {
    color: var(--studio-text);
    border-color: var(--studio-text-muted);
  }

  .sidebar-new-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`
