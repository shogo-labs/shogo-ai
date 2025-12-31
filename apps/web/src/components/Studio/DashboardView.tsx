/**
 * DashboardView - Stats and activity for selected feature
 *
 * Displays:
 * - Stats cards (requirements, tasks, findings, decisions, tests)
 * - Phase stepper showing progress
 * - Recent activity timeline
 */

import { useMemo } from "react"
import { StatusOrder, StatusToPhase } from "@shogo/state-api"

interface DashboardViewProps {
  feature: any
  platformFeatures: any
}

export function DashboardView({ feature, platformFeatures }: DashboardViewProps) {
  // Get related entities
  const requirements = platformFeatures.requirementCollection.findBySession(feature.id)
  const tasks = platformFeatures.implementationTaskCollection.findBySession(feature.id)
  const findings = platformFeatures.analysisFindingCollection.findBySession(feature.id)
  const decisions = platformFeatures.designDecisionCollection.findBySession(feature.id)
  const testCases = platformFeatures.testCaseCollection.findBySession(feature.id)
  const integrationPoints = platformFeatures.integrationPointCollection.findBySession(feature.id)

  // Calculate task stats
  const taskStats = useMemo(() => {
    const total = tasks.length
    const completed = tasks.filter((t: any) => t.status === "complete").length
    const inProgress = tasks.filter((t: any) => t.status === "in_progress").length
    const blocked = tasks.filter((t: any) => t.status === "blocked").length
    return { total, completed, inProgress, blocked }
  }, [tasks])

  // Calculate requirement stats
  const reqStats = useMemo(() => {
    const must = requirements.filter((r: any) => r.priority === "must").length
    const should = requirements.filter((r: any) => r.priority === "should").length
    const could = requirements.filter((r: any) => r.priority === "could").length
    return { must, should, could, total: requirements.length }
  }, [requirements])

  // Phase steps
  const phases = ["discovery", "design", "build", "deploy"]
  const currentPhase = feature.phase || "discovery"
  const currentPhaseIndex = phases.indexOf(currentPhase)

  // Recent activity (combine and sort by createdAt)
  const recentActivity = useMemo(() => {
    const allItems = [
      ...requirements.map((r: any) => ({ type: "requirement", item: r, date: r.createdAt })),
      ...tasks.map((t: any) => ({ type: "task", item: t, date: t.createdAt })),
      ...findings.map((f: any) => ({ type: "finding", item: f, date: f.createdAt })),
      ...decisions.map((d: any) => ({ type: "decision", item: d, date: d.createdAt })),
    ]
    return allItems
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, 10)
  }, [requirements, tasks, findings, decisions])

  return (
    <div className="dashboard-view">
      <style>{dashboardStyles}</style>

      {/* Feature header */}
      <div className="dashboard-header">
        <h1 className="dashboard-title">{feature.name}</h1>
        <p className="dashboard-intent">{feature.intent}</p>
      </div>

      {/* Phase stepper */}
      <div className="phase-stepper">
        {phases.map((phase, index) => (
          <div
            key={phase}
            className={`phase-step ${index <= currentPhaseIndex ? "active" : ""} ${
              index === currentPhaseIndex ? "current" : ""
            }`}
          >
            <div className="phase-indicator">
              {index < currentPhaseIndex ? "\u2713" : index + 1}
            </div>
            <span className="phase-label">{phase}</span>
          </div>
        ))}
        <div className="phase-connector" style={{ width: `${(currentPhaseIndex / (phases.length - 1)) * 100}%` }} />
      </div>

      {/* Stats grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{reqStats.total}</div>
          <div className="stat-label">Requirements</div>
          <div className="stat-breakdown">
            <span className="stat-tag must">{reqStats.must} must</span>
            <span className="stat-tag should">{reqStats.should} should</span>
            <span className="stat-tag could">{reqStats.could} could</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{taskStats.total}</div>
          <div className="stat-label">Tasks</div>
          <div className="stat-breakdown">
            <span className="stat-tag complete">{taskStats.completed} done</span>
            <span className="stat-tag progress">{taskStats.inProgress} active</span>
            {taskStats.blocked > 0 && (
              <span className="stat-tag blocked">{taskStats.blocked} blocked</span>
            )}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{findings.length}</div>
          <div className="stat-label">Findings</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{decisions.length}</div>
          <div className="stat-label">Decisions</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{testCases.length}</div>
          <div className="stat-label">Test Cases</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{integrationPoints.length}</div>
          <div className="stat-label">Integration Points</div>
        </div>
      </div>

      {/* Affected packages */}
      {feature.affectedPackages?.length > 0 && (
        <div className="packages-section">
          <h3 className="section-title">Affected Packages</h3>
          <div className="packages-list">
            {feature.affectedPackages.map((pkg: string) => (
              <span key={pkg} className="package-tag">{pkg}</span>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="activity-section">
        <h3 className="section-title">Recent Activity</h3>
        <div className="activity-list">
          {recentActivity.length === 0 ? (
            <div className="activity-empty">No activity yet</div>
          ) : (
            recentActivity.map((activity, index) => (
              <div key={index} className="activity-item">
                <span className={`activity-type type-${activity.type}`}>
                  {activity.type}
                </span>
                <span className="activity-name">{activity.item.name}</span>
                <span className="activity-date">
                  {activity.date ? new Date(activity.date).toLocaleDateString() : "-"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const dashboardStyles = `
  .dashboard-view {
    padding: 1.5rem;
    overflow-y: auto;
    height: 100%;
  }

  .dashboard-header {
    margin-bottom: 1.5rem;
  }

  .dashboard-title {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--studio-text);
  }

  .dashboard-intent {
    margin: 0;
    font-size: 0.875rem;
    color: var(--studio-text-muted);
    max-width: 600px;
  }

  /* Phase stepper */
  .phase-stepper {
    display: flex;
    align-items: center;
    gap: 2rem;
    margin-bottom: 2rem;
    padding: 1rem 1.5rem;
    background: var(--studio-bg-elevated);
    border-radius: 8px;
    position: relative;
  }

  .phase-step {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    z-index: 1;
  }

  .phase-indicator {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--studio-bg-card);
    color: var(--studio-text-muted);
    border: 2px solid var(--studio-border);
    transition: all 0.2s ease;
  }

  .phase-step.active .phase-indicator {
    background: var(--studio-accent);
    color: white;
    border-color: var(--studio-accent);
  }

  .phase-step.current .phase-indicator {
    box-shadow: 0 0 0 3px var(--studio-accent-hover);
  }

  .phase-label {
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: capitalize;
    color: var(--studio-text-muted);
  }

  .phase-step.active .phase-label {
    color: var(--studio-text);
  }

  .phase-connector {
    position: absolute;
    left: 2rem;
    top: 50%;
    height: 3px;
    background: var(--studio-accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    padding: 1rem;
    background: var(--studio-bg-elevated);
    border-radius: 8px;
    border: 1px solid var(--studio-border);
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--studio-text);
    line-height: 1;
    margin-bottom: 0.25rem;
  }

  .stat-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--studio-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.5rem;
  }

  .stat-breakdown {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .stat-tag {
    font-size: 0.625rem;
    font-weight: 500;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
  }

  .stat-tag.must { background: #ef444420; color: #f87171; }
  .stat-tag.should { background: #f59e0b20; color: #fbbf24; }
  .stat-tag.could { background: #22c55e20; color: #4ade80; }
  .stat-tag.complete { background: #22c55e20; color: #22c55e; }
  .stat-tag.progress { background: #3b82f620; color: #60a5fa; }
  .stat-tag.blocked { background: #ef444420; color: #f87171; }

  /* Packages section */
  .packages-section {
    margin-bottom: 2rem;
  }

  .section-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--studio-text);
    margin: 0 0 0.75rem;
  }

  .packages-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .package-tag {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: var(--studio-bg-elevated);
    border: 1px solid var(--studio-border);
    border-radius: 4px;
    color: var(--studio-text-muted);
    font-family: monospace;
  }

  /* Activity section */
  .activity-section {
    background: var(--studio-bg-elevated);
    border-radius: 8px;
    padding: 1rem;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .activity-empty {
    font-size: 0.875rem;
    color: var(--studio-text-muted);
    text-align: center;
    padding: 1rem;
  }

  .activity-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    border-radius: 4px;
    transition: background 0.15s ease;
  }

  .activity-item:hover {
    background: var(--studio-bg-card);
  }

  .activity-type {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    min-width: 70px;
    text-align: center;
  }

  .activity-type.type-requirement { background: #7c3aed20; color: #a78bfa; }
  .activity-type.type-task { background: #22c55e20; color: #4ade80; }
  .activity-type.type-finding { background: #3b82f620; color: #60a5fa; }
  .activity-type.type-decision { background: #f59e0b20; color: #fbbf24; }

  .activity-name {
    flex: 1;
    font-size: 0.875rem;
    color: var(--studio-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-date {
    font-size: 0.75rem;
    color: var(--studio-text-muted);
  }
`
