// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pre-built canvas states for agent templates.
 *
 * Each template gets multi-surface starter dashboards that load immediately
 * when the project is created, so users see real UI instead of "Waiting for
 * connection…". The agent can then update/replace these surfaces as needed.
 *
 * Format matches the `.canvas-state.json` persistence format used by
 * DynamicAppManager — { surfaces: { [surfaceId]: { … } } }.
 */

export interface TemplateCanvasState {
  surfaces: Record<string, {
    surfaceId: string
    title?: string
    components: Record<string, any>
    dataModel: Record<string, unknown>
    createdAt: string
    updatedAt: string
  }>
}

const NOW = '2026-01-01T00:00:00.000Z'

function surface(surfaceId: string, title: string, components: any[], dataModel: Record<string, unknown> = {}) {
  const comps: Record<string, any> = {}
  for (const c of components) comps[c.id] = c
  return { surfaceId, title, components: comps, dataModel, createdAt: NOW, updatedAt: NOW }
}

function multiSurface(...surfaces: ReturnType<typeof surface>[]): TemplateCanvasState {
  const result: TemplateCanvasState = { surfaces: {} }
  for (const s of surfaces) result.surfaces[s.surfaceId] = s
  return result
}

// ---------------------------------------------------------------------------
// Marketing Command Center
// ---------------------------------------------------------------------------
export const MARKETING_COMMAND_CENTER_CANVAS = multiSurface(
  surface('seo_dashboard', 'SEO Dashboard', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'audit_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔍 SEO Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Share your site URL to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_pages', 'kpi_keywords', 'kpi_score', 'kpi_issues'] },
    { id: 'kpi_pages', component: 'Metric', label: 'Pages Audited', value: { path: '/metrics/pages' } },
    { id: 'kpi_keywords', component: 'Metric', label: 'Keywords Tracked', value: { path: '/metrics/keywords' } },
    { id: 'kpi_score', component: 'Metric', label: 'SEO Score', value: { path: '/metrics/score' } },
    { id: 'kpi_issues', component: 'Metric', label: 'Issues Found', value: { path: '/metrics/issues' } },
    { id: 'audit_card', component: 'Card', title: 'SEO Audit', description: 'Technical and on-page audit results', child: 'audit_placeholder' },
    { id: 'audit_placeholder', component: 'Text', text: 'Share your website URL and I\'ll run a comprehensive SEO audit covering technical issues, on-page optimization, schema markup, and AI-search readiness.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Try: "Audit the SEO on https://example.com" — I\'ll analyze technical health, content optimization, and competitive keywords.', variant: 'muted' },
  ], { metrics: { pages: '0', keywords: '0', score: '—', issues: '0' } }),

  surface('content_hub', 'Content Hub', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'calendar_card', 'drafts_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '✍️ Content Hub', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to create', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_drafts', 'kpi_published', 'kpi_scheduled'] },
    { id: 'kpi_drafts', component: 'Metric', label: 'Drafts', value: { path: '/metrics/drafts' } },
    { id: 'kpi_published', component: 'Metric', label: 'Published', value: { path: '/metrics/published' } },
    { id: 'kpi_scheduled', component: 'Metric', label: 'Scheduled', value: { path: '/metrics/scheduled' } },
    { id: 'calendar_card', component: 'Card', title: 'Content Calendar', description: 'Upcoming posts and emails', child: 'cal_placeholder' },
    { id: 'cal_placeholder', component: 'Text', text: 'Your content calendar will track blog posts, social content, email campaigns, and newsletter editions all in one place.', variant: 'muted' },
    { id: 'drafts_card', component: 'Card', title: 'Recent Drafts', description: 'Copy, emails, and social posts', child: 'drafts_placeholder' },
    { id: 'drafts_placeholder', component: 'Text', text: 'Ask me to write anything: "Draft a homepage headline" or "Write a 5-email welcome sequence" — drafts appear here for review.', variant: 'muted' },
  ], { metrics: { drafts: '0', published: '0', scheduled: '0' } }),

  surface('competitor_watch', 'Competitor Watch', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'grid_card', 'changelog_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔍 Competitor Watch', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Add competitors to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_tracked', 'kpi_changes', 'kpi_alerts'] },
    { id: 'kpi_tracked', component: 'Metric', label: 'Competitors', value: { path: '/metrics/tracked' } },
    { id: 'kpi_changes', component: 'Metric', label: 'Changes (7d)', value: { path: '/metrics/changes' } },
    { id: 'kpi_alerts', component: 'Metric', label: 'Alerts', value: { path: '/metrics/alerts' } },
    { id: 'grid_card', component: 'Card', title: 'Comparison Grid', description: 'Features, pricing, and positioning', child: 'grid_placeholder' },
    { id: 'grid_placeholder', component: 'Text', text: 'Tell me your competitors and I\'ll build a side-by-side comparison of features, pricing, and messaging that stays current.', variant: 'muted' },
    { id: 'changelog_card', component: 'Card', title: 'Change Log', description: 'Detected changes across competitors', child: 'changelog_placeholder' },
    { id: 'changelog_placeholder', component: 'Text', text: 'I\'ll monitor competitor websites and log pricing, feature, and messaging changes automatically.', variant: 'muted' },
  ], { metrics: { tracked: '0', changes: '0', alerts: '0' } }),
)

// ---------------------------------------------------------------------------
// DevOps Hub
// ---------------------------------------------------------------------------
export const DEVOPS_HUB_CANVAS = multiSurface(
  surface('pr_queue', 'PR Queue', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'prs_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'ci_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🐙 PR Queue', variant: 'h2' },
    { id: 'ci_badge', component: 'Badge', text: 'Connect GitHub to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_open', 'kpi_review', 'kpi_stale', 'kpi_merged'] },
    { id: 'kpi_open', component: 'Metric', label: 'Open PRs', value: { path: '/metrics/openPrs' } },
    { id: 'kpi_review', component: 'Metric', label: 'Awaiting Review', value: { path: '/metrics/awaitingReview' } },
    { id: 'kpi_stale', component: 'Metric', label: 'Stale (>48h)', value: { path: '/metrics/stalePrs' } },
    { id: 'kpi_merged', component: 'Metric', label: 'Merged (7d)', value: { path: '/metrics/mergedWeek' } },
    { id: 'prs_card', component: 'Card', title: 'Pull Requests', description: 'Open PRs sorted by age', child: 'prs_placeholder' },
    { id: 'prs_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll populate this with your open PRs, auto-review small changes, and flag stale PRs needing attention.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect my GitHub" — I\'ll fetch your repos, triage PRs, and start auto-reviewing.', variant: 'muted' },
  ], { metrics: { openPrs: '—', awaitingReview: '—', stalePrs: '—', mergedWeek: '—' } }),

  surface('team_activity', 'Team Activity', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'standup_card', 'feed_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📊 Team Activity', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Not yet generated', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_commits', 'kpi_prs', 'kpi_reviews', 'kpi_velocity'] },
    { id: 'kpi_commits', component: 'Metric', label: 'Commits (24h)', value: { path: '/metrics/commits' } },
    { id: 'kpi_prs', component: 'Metric', label: 'PRs Merged', value: { path: '/metrics/prsMerged' } },
    { id: 'kpi_reviews', component: 'Metric', label: 'Reviews', value: { path: '/metrics/reviews' } },
    { id: 'kpi_velocity', component: 'Metric', label: 'Velocity', value: { path: '/metrics/velocity' } },
    { id: 'standup_card', component: 'Card', title: 'Standup Summary', description: 'Auto-generated from git activity', child: 'standup_placeholder' },
    { id: 'standup_placeholder', component: 'Text', text: 'Once GitHub is connected, standup summaries will be auto-generated here each morning with per-developer Done / In Progress / Blockers.', variant: 'muted' },
    { id: 'feed_card', component: 'Card', title: 'Activity Feed', description: 'Recent commits, PRs, and reviews', child: 'feed_placeholder' },
    { id: 'feed_placeholder', component: 'Text', text: 'A chronological feed of engineering activity across your tracked repos.', variant: 'muted' },
  ], { metrics: { commits: '—', prsMerged: '—', reviews: '—', velocity: '—' } }),

  surface('release_notes', 'Release Notes', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'changelog_card', 'checklist_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'version_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🚀 Release Notes', variant: 'h2' },
    { id: 'version_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_unreleased', 'kpi_days', 'kpi_deploy'] },
    { id: 'kpi_unreleased', component: 'Metric', label: 'Unreleased PRs', value: { path: '/metrics/unreleased' } },
    { id: 'kpi_days', component: 'Metric', label: 'Days Since Release', value: { path: '/metrics/daysSince' } },
    { id: 'kpi_deploy', component: 'Metric', label: 'Deploy Status', value: { path: '/metrics/deployStatus' } },
    { id: 'changelog_card', component: 'Card', title: 'Unreleased Changes', description: 'PRs merged since last release', child: 'changelog_placeholder' },
    { id: 'changelog_placeholder', component: 'Text', text: 'I\'ll automatically track merged PRs and generate changelogs grouped by Features, Fixes, and Breaking Changes.', variant: 'muted' },
    { id: 'checklist_card', component: 'Card', title: 'Deployment Checklist', description: 'Pre-release steps', child: 'checklist_content' },
    { id: 'checklist_content', component: 'Column', children: ['step1', 'step2', 'step3'], gap: 'sm' },
    { id: 'step1', component: 'Row', children: ['s1_badge', 's1_text'], align: 'center', gap: 'sm' },
    { id: 's1_badge', component: 'Badge', text: '1', variant: 'secondary' },
    { id: 's1_text', component: 'Text', text: 'Review changelog and breaking changes' },
    { id: 'step2', component: 'Row', children: ['s2_badge', 's2_text'], align: 'center', gap: 'sm' },
    { id: 's2_badge', component: 'Badge', text: '2', variant: 'secondary' },
    { id: 's2_text', component: 'Text', text: 'Verify CI pipeline is green' },
    { id: 'step3', component: 'Row', children: ['s3_badge', 's3_text'], align: 'center', gap: 'sm' },
    { id: 's3_badge', component: 'Badge', text: '3', variant: 'secondary' },
    { id: 's3_text', component: 'Text', text: 'Tag release and notify stakeholders' },
  ], { metrics: { unreleased: '—', daysSince: '—', deployStatus: '—' } }),
)

// ---------------------------------------------------------------------------
// Project Manager
// ---------------------------------------------------------------------------
export const PROJECT_MANAGER_CANVAS = multiSurface(
  surface('sprint_board', 'Sprint Board', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'board', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'sprint_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📋 Sprint Board', variant: 'h2' },
    { id: 'sprint_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_tasks', 'kpi_velocity', 'kpi_bugs', 'kpi_done'] },
    { id: 'kpi_tasks', component: 'Metric', label: 'Open Tasks', value: { path: '/metrics/openTasks' } },
    { id: 'kpi_velocity', component: 'Metric', label: 'Velocity', value: { path: '/metrics/velocity' }, unit: 'pts' },
    { id: 'kpi_bugs', component: 'Metric', label: 'Open Bugs', value: { path: '/metrics/bugs' } },
    { id: 'kpi_done', component: 'Metric', label: 'Done This Sprint', value: { path: '/metrics/done' } },
    { id: 'board', component: 'Grid', columns: 3, gap: 'md', children: ['todo_col', 'progress_col', 'done_col'] },
    { id: 'todo_col', component: 'Card', title: '📋 To Do', child: 'todo_placeholder' },
    { id: 'todo_placeholder', component: 'Text', text: 'Tasks will appear here', variant: 'muted' },
    { id: 'progress_col', component: 'Card', title: '🔄 In Progress', child: 'progress_placeholder' },
    { id: 'progress_placeholder', component: 'Text', text: 'Active tasks', variant: 'muted' },
    { id: 'done_col', component: 'Card', title: '✅ Done', child: 'done_placeholder' },
    { id: 'done_placeholder', component: 'Text', text: 'Completed tasks', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect Linear" to import tasks, or "Create a sprint board" to start tracking tasks directly here.', variant: 'muted' },
  ], { metrics: { openTasks: '—', velocity: '—', bugs: '—', done: '—' } }),

  surface('standup_summary', 'Standup Summary', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'summary_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🗓️ Standup Summary', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Not yet generated', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_active', 'kpi_blockers', 'kpi_items'] },
    { id: 'kpi_active', component: 'Metric', label: 'Team Active', value: { path: '/metrics/teamActive' } },
    { id: 'kpi_blockers', component: 'Metric', label: 'Blockers', value: { path: '/metrics/blockers' } },
    { id: 'kpi_items', component: 'Metric', label: 'Items in Flight', value: { path: '/metrics/inFlight' } },
    { id: 'summary_card', component: 'Card', title: 'Today\'s Summary', child: 'summary_placeholder' },
    { id: 'summary_placeholder', component: 'Text', text: 'Standup summaries will be generated here each morning from task activity and team updates.', variant: 'muted' },
  ], { metrics: { teamActive: '—', blockers: '—', inFlight: '—' } }),
)

// ---------------------------------------------------------------------------
// Sales & Revenue
// ---------------------------------------------------------------------------
export const SALES_REVENUE_CANVAS = multiSurface(
  surface('sales_pipeline', 'Sales Pipeline', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'board', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🏆 Sales Pipeline', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_value', 'kpi_deals', 'kpi_conversion', 'kpi_avg'] },
    { id: 'kpi_value', component: 'Metric', label: 'Pipeline Value', value: { path: '/metrics/value' }, unit: '$' },
    { id: 'kpi_deals', component: 'Metric', label: 'Active Deals', value: { path: '/metrics/deals' } },
    { id: 'kpi_conversion', component: 'Metric', label: 'Win Rate', value: { path: '/metrics/conversion' } },
    { id: 'kpi_avg', component: 'Metric', label: 'Avg Deal Size', value: { path: '/metrics/avgDeal' }, unit: '$' },
    { id: 'board', component: 'Grid', columns: 5, gap: 'md', children: ['new_col', 'qualified_col', 'proposal_col', 'negotiation_col', 'closed_col'] },
    { id: 'new_col', component: 'Card', title: '🆕 New', child: 'new_ph' },
    { id: 'new_ph', component: 'Text', text: 'New leads', variant: 'muted' },
    { id: 'qualified_col', component: 'Card', title: '✅ Qualified', child: 'qual_ph' },
    { id: 'qual_ph', component: 'Text', text: 'Qualified leads', variant: 'muted' },
    { id: 'proposal_col', component: 'Card', title: '📄 Proposal', child: 'prop_ph' },
    { id: 'prop_ph', component: 'Text', text: 'Proposals sent', variant: 'muted' },
    { id: 'negotiation_col', component: 'Card', title: '🤝 Negotiation', child: 'neg_ph' },
    { id: 'neg_ph', component: 'Text', text: 'In negotiation', variant: 'muted' },
    { id: 'closed_col', component: 'Card', title: '🏆 Won', child: 'won_ph' },
    { id: 'won_ph', component: 'Text', text: 'Closed deals', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me about your sales process and I\'ll set up a pipeline with deal tracking and revenue forecasting.', variant: 'muted' },
  ], { metrics: { value: '—', deals: '0', conversion: '—', avgDeal: '—' } }),

  surface('revenue_dashboard', 'Revenue Dashboard', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'payments_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '💰 Revenue Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Connect Stripe to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_mrr', 'kpi_balance', 'kpi_pending', 'kpi_customers'] },
    { id: 'kpi_mrr', component: 'Metric', label: 'MRR', value: { path: '/metrics/mrr' }, unit: '$' },
    { id: 'kpi_balance', component: 'Metric', label: 'Balance', value: { path: '/metrics/balance' }, unit: '$' },
    { id: 'kpi_pending', component: 'Metric', label: 'Pending', value: { path: '/metrics/pending' } },
    { id: 'kpi_customers', component: 'Metric', label: 'Customers', value: { path: '/metrics/customers' } },
    { id: 'payments_card', component: 'Card', title: 'Payment Activity', child: 'payments_placeholder' },
    { id: 'payments_placeholder', component: 'Text', text: 'Say "Connect Stripe" and I\'ll pull live revenue data with trend charts and failed payment alerts.', variant: 'muted' },
  ], { metrics: { mrr: '—', balance: '—', pending: '—', customers: '—' } }),
)

// ---------------------------------------------------------------------------
// Support Operations
// ---------------------------------------------------------------------------
export const SUPPORT_OPS_CANVAS = multiSurface(
  surface('ticket_queue', 'Ticket Queue', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'tickets_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🎫 Ticket Queue', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Connect ticketing tool', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_open', 'kpi_resolved', 'kpi_response', 'kpi_csat'] },
    { id: 'kpi_open', component: 'Metric', label: 'Open', value: { path: '/metrics/open' } },
    { id: 'kpi_resolved', component: 'Metric', label: 'Resolved (7d)', value: { path: '/metrics/resolved' } },
    { id: 'kpi_response', component: 'Metric', label: 'Avg Response', value: { path: '/metrics/responseTime' } },
    { id: 'kpi_csat', component: 'Metric', label: 'CSAT', value: { path: '/metrics/csat' } },
    { id: 'tickets_card', component: 'Card', title: 'Tickets by Priority', child: 'tickets_content' },
    { id: 'tickets_content', component: 'Column', children: ['p0_row', 'p1_row', 'p2_row'], gap: 'sm' },
    { id: 'p0_row', component: 'Row', children: ['p0_badge', 'p0_text'], align: 'center', gap: 'sm' },
    { id: 'p0_badge', component: 'Badge', text: 'P0 Critical', variant: 'destructive' },
    { id: 'p0_text', component: 'Text', text: 'Immediate alert + escalation', variant: 'muted' },
    { id: 'p1_row', component: 'Row', children: ['p1_badge', 'p1_text'], align: 'center', gap: 'sm' },
    { id: 'p1_badge', component: 'Badge', text: 'P1 High', variant: 'default' },
    { id: 'p1_text', component: 'Text', text: 'Alert within 15 minutes', variant: 'muted' },
    { id: 'p2_row', component: 'Row', children: ['p2_badge', 'p2_text'], align: 'center', gap: 'sm' },
    { id: 'p2_badge', component: 'Badge', text: 'P2 Medium', variant: 'secondary' },
    { id: 'p2_text', component: 'Text', text: 'Included in daily digest', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect Zendesk" or "Connect Linear" — I\'ll pull tickets, auto-triage, and build SLA tracking.', variant: 'muted' },
  ], { metrics: { open: '—', resolved: '—', responseTime: '—', csat: '—' } }),

  surface('incident_tracker', 'Incident Tracker', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'incidents_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'all_ok_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🚨 Incident Tracker', variant: 'h2' },
    { id: 'all_ok_badge', component: 'Badge', text: 'No active incidents', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_active', 'kpi_mttr', 'kpi_total'] },
    { id: 'kpi_active', component: 'Metric', label: 'Active Incidents', value: { path: '/metrics/active' } },
    { id: 'kpi_mttr', component: 'Metric', label: 'Avg MTTR', value: { path: '/metrics/mttr' } },
    { id: 'kpi_total', component: 'Metric', label: 'Incidents (30d)', value: { path: '/metrics/total' } },
    { id: 'incidents_card', component: 'Card', title: 'Incident History', child: 'incidents_placeholder' },
    { id: 'incidents_placeholder', component: 'Text', text: 'Incidents will be logged here with timelines, affected services, and resolution details.', variant: 'muted' },
  ], { metrics: { active: '0', mttr: '—', total: '0' } }),
)

// ---------------------------------------------------------------------------
// Research Analyst
// ---------------------------------------------------------------------------
export const RESEARCH_ANALYST_CANVAS = multiSurface(
  surface('research_dashboard', 'Research Dashboard', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'topics_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔬 Research Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to research', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_topics', 'kpi_sources', 'kpi_updated'] },
    { id: 'kpi_topics', component: 'Metric', label: 'Tracked Topics', value: { path: '/metrics/topics' } },
    { id: 'kpi_sources', component: 'Metric', label: 'Sources Indexed', value: { path: '/metrics/sources' } },
    { id: 'kpi_updated', component: 'Metric', label: 'Last Updated', value: { path: '/metrics/updated' } },
    { id: 'topics_card', component: 'Card', title: 'Active Research', description: 'Your research projects', child: 'topics_placeholder' },
    { id: 'topics_placeholder', component: 'Text', text: 'Tell me a topic to research and I\'ll search the web, synthesize findings, and build an analysis dashboard. Try: "Research the latest developments in AI agents"', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'I research from 5+ sources, distinguish facts from opinions, and always cite URLs. Ask anything.', variant: 'muted' },
  ], { metrics: { topics: '0', sources: '0', updated: 'Never' } }),

  surface('topic_tracker', 'Topic Tracker', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'tracked_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📡 Topic Tracker', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No topics tracked yet', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_tracked', 'kpi_new', 'kpi_alerts'] },
    { id: 'kpi_tracked', component: 'Metric', label: 'Topics Tracked', value: { path: '/metrics/tracked' } },
    { id: 'kpi_new', component: 'Metric', label: 'New Today', value: { path: '/metrics/newToday' } },
    { id: 'kpi_alerts', component: 'Metric', label: 'Alerts', value: { path: '/metrics/alerts' } },
    { id: 'tracked_card', component: 'Card', title: 'Monitored Topics', child: 'tracked_placeholder' },
    { id: 'tracked_placeholder', component: 'Text', text: 'Say "Track AI agents" or "Monitor quantum computing news" — I\'ll check for developments on every heartbeat and alert you.', variant: 'muted' },
  ], { metrics: { tracked: '0', newToday: '0', alerts: '0' } }),
)

// ---------------------------------------------------------------------------
// HR & Recruiting
// ---------------------------------------------------------------------------
export const HR_RECRUITING_CANVAS = multiSurface(
  surface('hiring_pipeline', 'Hiring Pipeline', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'board', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '👥 Hiring Pipeline', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_candidates', 'kpi_roles', 'kpi_tth', 'kpi_offer'] },
    { id: 'kpi_candidates', component: 'Metric', label: 'Active Candidates', value: { path: '/metrics/candidates' } },
    { id: 'kpi_roles', component: 'Metric', label: 'Open Roles', value: { path: '/metrics/roles' } },
    { id: 'kpi_tth', component: 'Metric', label: 'Avg Time-to-Hire', value: { path: '/metrics/timeToHire' }, unit: 'days' },
    { id: 'kpi_offer', component: 'Metric', label: 'Offer Rate', value: { path: '/metrics/offerRate' } },
    { id: 'board', component: 'Grid', columns: 5, gap: 'md', children: ['applied_col', 'screen_col', 'interview_col', 'offer_col', 'hired_col'] },
    { id: 'applied_col', component: 'Card', title: '📩 Applied', child: 'applied_ph' },
    { id: 'applied_ph', component: 'Text', text: 'New applicants', variant: 'muted' },
    { id: 'screen_col', component: 'Card', title: '📞 Screen', child: 'screen_ph' },
    { id: 'screen_ph', component: 'Text', text: 'Phone screen', variant: 'muted' },
    { id: 'interview_col', component: 'Card', title: '🗣️ Interview', child: 'interview_ph' },
    { id: 'interview_ph', component: 'Text', text: 'Interviewing', variant: 'muted' },
    { id: 'offer_col', component: 'Card', title: '📋 Offer', child: 'offer_ph' },
    { id: 'offer_ph', component: 'Text', text: 'Offer sent', variant: 'muted' },
    { id: 'hired_col', component: 'Card', title: '🎉 Hired', child: 'hired_ph' },
    { id: 'hired_ph', component: 'Text', text: 'Welcome!', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your open roles and I\'ll set up candidate tracking, interview scheduling, and hiring metrics.', variant: 'muted' },
  ], { metrics: { candidates: '0', roles: '0', timeToHire: '—', offerRate: '—' } }),
)

// ---------------------------------------------------------------------------
// Personal Assistant
// ---------------------------------------------------------------------------
export const PERSONAL_ASSISTANT_CANVAS = multiSurface(
  surface('daily_planner', 'Daily Planner', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'schedule_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '⚡ Daily Planner', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_meetings', 'kpi_tasks', 'kpi_reminders', 'kpi_streak'] },
    { id: 'kpi_meetings', component: 'Metric', label: 'Meetings Today', value: { path: '/metrics/meetings' } },
    { id: 'kpi_tasks', component: 'Metric', label: 'Open Tasks', value: { path: '/metrics/tasks' } },
    { id: 'kpi_reminders', component: 'Metric', label: 'Reminders', value: { path: '/metrics/reminders' } },
    { id: 'kpi_streak', component: 'Metric', label: 'Habit Streak', value: { path: '/metrics/streak' }, unit: 'days' },
    { id: 'schedule_card', component: 'Card', title: 'Today\'s Schedule', child: 'schedule_placeholder' },
    { id: 'schedule_placeholder', component: 'Text', text: 'Connect your calendar and I\'ll show today\'s meetings with prep notes. Say "Connect Google Calendar" to start.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up your personal hub:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• "Connect my Google Calendar" for daily schedule' },
    { id: 'opt2', component: 'Text', text: '• "Track exercise and reading habits" for habit tracking' },
    { id: 'opt3', component: 'Text', text: '• "Remind me to..." for reminders and tasks' },
  ], { metrics: { meetings: '—', tasks: '0', reminders: '0', streak: '0' } }),

  surface('journal', 'Journal', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'today_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'streak_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📓 Journal', variant: 'h2' },
    { id: 'streak_badge', component: 'Badge', text: 'Start your first entry', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_streak', 'kpi_entries', 'kpi_mood'] },
    { id: 'kpi_streak', component: 'Metric', label: 'Streak', value: { path: '/metrics/streak' }, unit: 'days' },
    { id: 'kpi_entries', component: 'Metric', label: 'Entries', value: { path: '/metrics/entries' } },
    { id: 'kpi_mood', component: 'Metric', label: 'Avg Mood', value: { path: '/metrics/mood' } },
    { id: 'today_card', component: 'Card', title: 'Today\'s Reflection', child: 'prompt_text' },
    { id: 'prompt_text', component: 'Text', text: 'Just tell me how your day went — I\'ll track mood, gratitude, and themes over time.', variant: 'muted' },
  ], { metrics: { streak: '0', entries: '0', mood: '—' } }),
)

// ---------------------------------------------------------------------------
// Operations Monitor
// ---------------------------------------------------------------------------
export const OPERATIONS_MONITOR_CANVAS = multiSurface(
  surface('health_dashboard', 'Health Dashboard', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'services_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'all_ok_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '💓 Health Dashboard', variant: 'h2' },
    { id: 'all_ok_badge', component: 'Badge', text: 'No endpoints configured', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_endpoints', 'kpi_uptime', 'kpi_latency', 'kpi_incidents'] },
    { id: 'kpi_endpoints', component: 'Metric', label: 'Endpoints', value: { path: '/metrics/endpoints' } },
    { id: 'kpi_uptime', component: 'Metric', label: 'Uptime', value: { path: '/metrics/uptime' } },
    { id: 'kpi_latency', component: 'Metric', label: 'Avg Latency', value: { path: '/metrics/latency' }, unit: 'ms' },
    { id: 'kpi_incidents', component: 'Metric', label: 'Incidents (24h)', value: { path: '/metrics/incidents' } },
    { id: 'services_card', component: 'Card', title: 'Service Status', child: 'services_content' },
    { id: 'services_content', component: 'Column', children: ['svc1', 'svc2', 'svc3'], gap: 'sm' },
    { id: 'svc1', component: 'Row', children: ['svc1_badge', 'svc1_text', 'svc1_latency'], align: 'center', justify: 'between' },
    { id: 'svc1_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'svc1_text', component: 'Text', text: 'API Server' },
    { id: 'svc1_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'svc2', component: 'Row', children: ['svc2_badge', 'svc2_text', 'svc2_latency'], align: 'center', justify: 'between' },
    { id: 'svc2_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'svc2_text', component: 'Text', text: 'Database' },
    { id: 'svc2_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'svc3', component: 'Row', children: ['svc3_badge', 'svc3_text', 'svc3_latency'], align: 'center', justify: 'between' },
    { id: 'svc3_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'svc3_text', component: 'Text', text: 'CDN / Frontend' },
    { id: 'svc3_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Share your API health check URLs and I\'ll start monitoring every 5 minutes. Say "Connect Sentry" for error tracking.', variant: 'muted' },
  ], { metrics: { endpoints: '0', uptime: '—', latency: '—', incidents: '0' } }),

  surface('alert_feed', 'Alert Feed', [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'alerts_card'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔔 Alert Feed', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No alerts yet', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_today', 'kpi_unresolved', 'kpi_keywords'] },
    { id: 'kpi_today', component: 'Metric', label: 'Alerts Today', value: { path: '/metrics/alertsToday' } },
    { id: 'kpi_unresolved', component: 'Metric', label: 'Unresolved', value: { path: '/metrics/unresolved' } },
    { id: 'kpi_keywords', component: 'Metric', label: 'Keywords Watched', value: { path: '/metrics/keywords' } },
    { id: 'alerts_card', component: 'Card', title: 'Recent Alerts', child: 'alerts_placeholder' },
    { id: 'alerts_placeholder', component: 'Text', text: 'Health check failures, Slack keyword matches, and escalations will be logged here chronologically.', variant: 'muted' },
  ], { metrics: { alertsToday: '0', unresolved: '0', keywords: '0' } }),
)

// ---------------------------------------------------------------------------
// Blank Agent (no starter surfaces)
// ---------------------------------------------------------------------------
export const BLANK_AGENT_CANVAS: TemplateCanvasState = { surfaces: {} }

// ---------------------------------------------------------------------------
// Lookup map
// ---------------------------------------------------------------------------
export const TEMPLATE_CANVAS_STATES: Record<string, TemplateCanvasState> = {
  'marketing-command-center': MARKETING_COMMAND_CENTER_CANVAS,
  'devops-hub': DEVOPS_HUB_CANVAS,
  'project-manager': PROJECT_MANAGER_CANVAS,
  'sales-revenue': SALES_REVENUE_CANVAS,
  'support-ops': SUPPORT_OPS_CANVAS,
  'research-analyst': RESEARCH_ANALYST_CANVAS,
  'hr-recruiting': HR_RECRUITING_CANVAS,
  'personal-assistant': PERSONAL_ASSISTANT_CANVAS,
  'operations-monitor': OPERATIONS_MONITOR_CANVAS,
  'blank-agent': BLANK_AGENT_CANVAS,
}
