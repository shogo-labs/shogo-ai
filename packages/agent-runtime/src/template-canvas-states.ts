// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pre-built canvas states for agent templates.
 *
 * Each template gets a starter dashboard that loads immediately when the
 * project is created, so users see a real UI instead of "Waiting for
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

function cs(surfaceId: string, title: string, components: any[], dataModel: Record<string, unknown> = {}): TemplateCanvasState {
  const comps: Record<string, any> = {}
  for (const c of components) comps[c.id] = c
  return {
    surfaces: {
      [surfaceId]: { surfaceId, title, components: comps, dataModel, createdAt: NOW, updatedAt: NOW },
    },
  }
}

// ---------------------------------------------------------------------------
// Research Assistant
// ---------------------------------------------------------------------------
export const RESEARCH_ASSISTANT_CANVAS = cs(
  'research_dashboard', 'Research Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'topics_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📚 Research Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to research', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_topics', 'kpi_sources', 'kpi_updated'] },
    { id: 'kpi_topics', component: 'Metric', label: 'Tracked Topics', value: { path: '/metrics/topics' } },
    { id: 'kpi_sources', component: 'Metric', label: 'Sources Indexed', value: { path: '/metrics/sources' } },
    { id: 'kpi_updated', component: 'Metric', label: 'Last Updated', value: { path: '/metrics/updated' } },
    { id: 'topics_card', component: 'Card', title: 'Sample Topics', description: 'Ask me to research any topic — I\'ll build a full analysis here', child: 'topics_list' },
    { id: 'topics_list', component: 'Column', children: ['topic1', 'topic2', 'topic3'], gap: 'sm' },
    { id: 'topic1', component: 'Row', children: ['t1_text', 't1_badge'], align: 'center', justify: 'between' },
    { id: 't1_text', component: 'Text', text: 'AI Industry Trends 2026' },
    { id: 't1_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'topic2', component: 'Row', children: ['t2_text', 't2_badge'], align: 'center', justify: 'between' },
    { id: 't2_text', component: 'Text', text: 'Competitive Landscape Analysis' },
    { id: 't2_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'topic3', component: 'Row', children: ['t3_text', 't3_badge'], align: 'center', justify: 'between' },
    { id: 't3_text', component: 'Text', text: 'Market Sizing & TAM Research' },
    { id: 't3_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me a topic to research and I\'ll search the web, synthesize findings, and build an interactive dashboard right here. Try: "Research the latest developments in AI agents"', variant: 'muted' },
  ],
  { metrics: { topics: '0', sources: '0', updated: 'Never' } },
)

// ---------------------------------------------------------------------------
// GitHub Ops
// ---------------------------------------------------------------------------
export const GITHUB_OPS_CANVAS = cs(
  'github_dashboard', 'GitHub Operations',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'pr_card', 'issues_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'ci_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🐙 GitHub Operations', variant: 'h2' },
    { id: 'ci_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_prs', 'kpi_issues', 'kpi_ci', 'kpi_releases'] },
    { id: 'kpi_prs', component: 'Metric', label: 'Open PRs', value: { path: '/metrics/openPrs' } },
    { id: 'kpi_issues', component: 'Metric', label: 'Open Issues', value: { path: '/metrics/openIssues' } },
    { id: 'kpi_ci', component: 'Metric', label: 'CI Status', value: { path: '/metrics/ciStatus' } },
    { id: 'kpi_releases', component: 'Metric', label: 'This Week', value: { path: '/metrics/releases' } },
    { id: 'pr_card', component: 'Card', title: 'Pull Requests', description: 'Connect GitHub to see your open PRs', child: 'pr_placeholder' },
    { id: 'pr_placeholder', component: 'Text', text: 'PRs will appear here once you connect your GitHub account. I\'ll track review status, CI checks, and age of each PR.', variant: 'muted' },
    { id: 'issues_card', component: 'Card', title: 'Issues', description: 'Recent issues across your repos', child: 'issues_placeholder' },
    { id: 'issues_placeholder', component: 'Text', text: 'Issues will be triaged by severity and shown here. I\'ll alert you immediately on critical issues.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect my GitHub" and I\'ll install the GitHub integration via OAuth. Once connected, I\'ll fetch your repos, open PRs, and issues to build a live triage dashboard.', variant: 'muted' },
  ],
  { metrics: { openPrs: '—', openIssues: '—', ciStatus: '—', releases: '—' } },
)

// ---------------------------------------------------------------------------
// Support Desk
// ---------------------------------------------------------------------------
export const SUPPORT_DESK_CANVAS = cs(
  'support_dashboard', 'Support Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'tickets_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🎫 Support Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No ticketing tool connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_open', 'kpi_resolved', 'kpi_response', 'kpi_csat'] },
    { id: 'kpi_open', component: 'Metric', label: 'Open Tickets', value: { path: '/metrics/open' } },
    { id: 'kpi_resolved', component: 'Metric', label: 'Resolved (7d)', value: { path: '/metrics/resolved' } },
    { id: 'kpi_response', component: 'Metric', label: 'Avg Response', value: { path: '/metrics/responseTime' } },
    { id: 'kpi_csat', component: 'Metric', label: 'CSAT Score', value: { path: '/metrics/csat' } },
    { id: 'tickets_card', component: 'Card', title: 'Tickets', description: 'Connect a ticketing tool to see your queue', child: 'tickets_content' },
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
    { id: 'gs_text', component: 'Text', text: 'Say "Connect Zendesk" or "Connect Linear" and I\'ll install the integration. Once connected, I\'ll pull your tickets, categorize by severity, and build a live dashboard with KPIs and alerts.', variant: 'muted' },
  ],
  { metrics: { open: '—', resolved: '—', responseTime: '—', csat: '—' } },
)

// ---------------------------------------------------------------------------
// Meeting Prep
// ---------------------------------------------------------------------------
export const MEETING_PREP_CANVAS = cs(
  'meeting_dashboard', 'Today\'s Meetings',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'timeline_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📝 Meeting Prep', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'No calendar connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_meetings', 'kpi_external', 'kpi_time'] },
    { id: 'kpi_meetings', component: 'Metric', label: 'Today\'s Meetings', value: { path: '/metrics/meetings' } },
    { id: 'kpi_external', component: 'Metric', label: 'External Attendees', value: { path: '/metrics/external' } },
    { id: 'kpi_time', component: 'Metric', label: 'Total Time', value: { path: '/metrics/totalTime' } },
    { id: 'timeline_card', component: 'Card', title: 'Schedule', description: 'Connect your calendar to see today\'s meetings', child: 'timeline' },
    { id: 'timeline', component: 'Column', children: ['meeting1', 'meeting2'], gap: 'md' },
    { id: 'meeting1', component: 'Card', title: '🔵 9:00 AM — Team Standup', description: '15 min · 5 attendees · Internal', children: [] },
    { id: 'meeting2', component: 'Card', title: '🟠 10:30 AM — Client Demo', description: '1 hour · 3 attendees · External', children: [] },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Connect your calendar and I\'ll automatically prep for your meetings:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect my Google Calendar" for automatic setup' },
    { id: 'opt2', component: 'Text', text: '• Or tell me about a meeting: "I have a call with Acme Corp at 2pm"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll research attendees, build prep docs, and track action items' },
  ],
  { metrics: { meetings: '—', external: '—', totalTime: '—' } },
)

// ---------------------------------------------------------------------------
// Revenue Tracker
// ---------------------------------------------------------------------------
export const REVENUE_TRACKER_CANVAS = cs(
  'revenue_dashboard', 'Revenue Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'payments_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '💰 Revenue Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No payment tool connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_mrr', 'kpi_balance', 'kpi_pending', 'kpi_customers'] },
    { id: 'kpi_mrr', component: 'Metric', label: 'MRR', value: { path: '/metrics/mrr' }, unit: '$' },
    { id: 'kpi_balance', component: 'Metric', label: 'Total Balance', value: { path: '/metrics/balance' }, unit: '$' },
    { id: 'kpi_pending', component: 'Metric', label: 'Pending', value: { path: '/metrics/pending' } },
    { id: 'kpi_customers', component: 'Metric', label: 'Customers', value: { path: '/metrics/customers' } },
    { id: 'payments_card', component: 'Card', title: 'Recent Payments', description: 'Connect Stripe to see live transaction data', child: 'payments_placeholder' },
    { id: 'payments_placeholder', component: 'Text', text: 'Payment history, invoice management, and trend charts will appear here once you connect your payment processor.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect Stripe" and I\'ll install the integration via OAuth. Once connected, I\'ll pull your revenue data, build trend charts, and alert you on failed payments or unusual activity.', variant: 'muted' },
  ],
  { metrics: { mrr: '—', balance: '—', pending: '—', customers: '—' } },
)

// ---------------------------------------------------------------------------
// Project Board
// ---------------------------------------------------------------------------
export const PROJECT_BOARD_CANVAS = cs(
  'sprint_board', 'Sprint Board',
  [
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
    { id: 'progress_placeholder', component: 'Text', text: 'Active tasks will appear here', variant: 'muted' },
    { id: 'done_col', component: 'Card', title: '✅ Done', child: 'done_placeholder' },
    { id: 'done_placeholder', component: 'Text', text: 'Completed tasks will appear here', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up your sprint board:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect Linear" to import tasks from your project tracker' },
    { id: 'opt2', component: 'Text', text: '• Or say "Create a sprint board" and I\'ll set up task tracking here' },
    { id: 'opt3', component: 'Text', text: '• I\'ll track velocity, manage standups, and alert on blocked items' },
  ],
  { metrics: { openTasks: '—', velocity: '—', bugs: '—', done: '—' } },
)

// ---------------------------------------------------------------------------
// Incident Commander
// ---------------------------------------------------------------------------
export const INCIDENT_COMMANDER_CANVAS = cs(
  'status_page', 'Service Status',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'services_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'all_ok_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🚨 Service Status', variant: 'h2' },
    { id: 'all_ok_badge', component: 'Badge', text: 'No services configured', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_services', 'kpi_uptime', 'kpi_incidents', 'kpi_latency'] },
    { id: 'kpi_services', component: 'Metric', label: 'Services', value: { path: '/metrics/services' } },
    { id: 'kpi_uptime', component: 'Metric', label: 'Uptime', value: { path: '/metrics/uptime' } },
    { id: 'kpi_incidents', component: 'Metric', label: 'Open Incidents', value: { path: '/metrics/incidents' } },
    { id: 'kpi_latency', component: 'Metric', label: 'Avg Latency', value: { path: '/metrics/latency' } },
    { id: 'services_card', component: 'Card', title: 'Monitored Services', description: 'Configure health check URLs to start monitoring', child: 'services_content' },
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
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up monitoring:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Share your health check URLs and I\'ll start monitoring' },
    { id: 'opt2', component: 'Text', text: '• Say "Connect Sentry" or "Connect Datadog" for error tracking' },
    { id: 'opt3', component: 'Text', text: '• I\'ll alert immediately on failures and build incident timelines' },
  ],
  { metrics: { services: '0', uptime: '—', incidents: '0', latency: '—' } },
)

// ---------------------------------------------------------------------------
// Personal Assistant
// ---------------------------------------------------------------------------
export const PERSONAL_ASSISTANT_CANVAS = cs(
  'habit_tracker', 'Daily Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'habits_card', 'reminders_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '⚡ Daily Dashboard', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_habits', 'kpi_streak', 'kpi_reminders'] },
    { id: 'kpi_habits', component: 'Metric', label: 'Active Habits', value: { path: '/metrics/habits' } },
    { id: 'kpi_streak', component: 'Metric', label: 'Best Streak', value: { path: '/metrics/streak' }, unit: 'days' },
    { id: 'kpi_reminders', component: 'Metric', label: 'Reminders Today', value: { path: '/metrics/reminders' } },
    { id: 'habits_card', component: 'Card', title: 'Habits', description: 'Track your daily routines', child: 'habits_content' },
    { id: 'habits_content', component: 'Column', children: ['habit1', 'habit2', 'habit3'], gap: 'sm' },
    { id: 'habit1', component: 'Row', children: ['h1_text', 'h1_badge'], align: 'center', justify: 'between' },
    { id: 'h1_text', component: 'Text', text: '🏃 Exercise' },
    { id: 'h1_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'habit2', component: 'Row', children: ['h2_text', 'h2_badge'], align: 'center', justify: 'between' },
    { id: 'h2_text', component: 'Text', text: '📖 Read 30 minutes' },
    { id: 'h2_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'habit3', component: 'Row', children: ['h3_text', 'h3_badge'], align: 'center', justify: 'between' },
    { id: 'h3_text', component: 'Text', text: '💧 Drink 8 glasses of water' },
    { id: 'h3_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'reminders_card', component: 'Card', title: 'Reminders', description: 'Upcoming reminders and tasks', child: 'reminders_placeholder' },
    { id: 'reminders_placeholder', component: 'Text', text: 'Tell me what to remind you about and I\'ll track it here. I\'ll send you nudges at the right time.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up your personal dashboard:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Tell me your habits: "Track exercise, reading, and meditation"' },
    { id: 'opt2', component: 'Text', text: '• Set reminders: "Remind me to call mom every Sunday at 5pm"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll build an interactive tracker with streaks and check-in buttons' },
  ],
  { metrics: { habits: '0', streak: '0', reminders: '0' } },
)

// ---------------------------------------------------------------------------
// Sales Pipeline
// ---------------------------------------------------------------------------
export const SALES_PIPELINE_CANVAS = cs(
  'sales_pipeline', 'Sales Pipeline',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'board', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🏆 Sales Pipeline', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_value', 'kpi_deals', 'kpi_conversion', 'kpi_avg'] },
    { id: 'kpi_value', component: 'Metric', label: 'Pipeline Value', value: { path: '/metrics/value' }, unit: '$' },
    { id: 'kpi_deals', component: 'Metric', label: 'Active Deals', value: { path: '/metrics/deals' } },
    { id: 'kpi_conversion', component: 'Metric', label: 'Conversion Rate', value: { path: '/metrics/conversion' } },
    { id: 'kpi_avg', component: 'Metric', label: 'Avg Deal Size', value: { path: '/metrics/avgDeal' }, unit: '$' },
    { id: 'board', component: 'Grid', columns: 5, gap: 'md', children: ['new_col', 'qualified_col', 'proposal_col', 'negotiation_col', 'closed_col'] },
    { id: 'new_col', component: 'Card', title: '🆕 New', child: 'new_placeholder' },
    { id: 'new_placeholder', component: 'Text', text: 'New leads appear here', variant: 'muted' },
    { id: 'qualified_col', component: 'Card', title: '✅ Qualified', child: 'qualified_placeholder' },
    { id: 'qualified_placeholder', component: 'Text', text: 'Qualified leads', variant: 'muted' },
    { id: 'proposal_col', component: 'Card', title: '📄 Proposal', child: 'proposal_placeholder' },
    { id: 'proposal_placeholder', component: 'Text', text: 'Proposals sent', variant: 'muted' },
    { id: 'negotiation_col', component: 'Card', title: '🤝 Negotiation', child: 'negotiation_placeholder' },
    { id: 'negotiation_placeholder', component: 'Text', text: 'In negotiation', variant: 'muted' },
    { id: 'closed_col', component: 'Card', title: '🏆 Closed Won', child: 'closed_placeholder' },
    { id: 'closed_placeholder', component: 'Text', text: 'Closed deals', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me about your sales process and I\'ll set up a pipeline with deal tracking, follow-up reminders, and revenue forecasting. Try: "I sell B2B SaaS with a 30-day sales cycle"', variant: 'muted' },
  ],
  { metrics: { value: '—', deals: '0', conversion: '—', avgDeal: '—' } },
)

// ---------------------------------------------------------------------------
// Social Media Manager
// ---------------------------------------------------------------------------
export const SOCIAL_MEDIA_MANAGER_CANVAS = cs(
  'social_dashboard', 'Social Media Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'content_card', 'trends_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📱 Social Media Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to configure', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_followers', 'kpi_engagement', 'kpi_posts', 'kpi_top'] },
    { id: 'kpi_followers', component: 'Metric', label: 'Followers', value: { path: '/metrics/followers' } },
    { id: 'kpi_engagement', component: 'Metric', label: 'Engagement Rate', value: { path: '/metrics/engagement' } },
    { id: 'kpi_posts', component: 'Metric', label: 'Posts This Week', value: { path: '/metrics/posts' } },
    { id: 'kpi_top', component: 'Metric', label: 'Top Post Likes', value: { path: '/metrics/topPost' } },
    { id: 'content_card', component: 'Card', title: 'Content Calendar', description: 'Upcoming posts and drafts', child: 'content_placeholder' },
    { id: 'content_placeholder', component: 'Text', text: 'Your content calendar will appear here. I\'ll help you plan, draft, and schedule posts across platforms.', variant: 'muted' },
    { id: 'trends_card', component: 'Card', title: 'Trending Topics', description: 'Relevant trends in your industry', child: 'trends_content' },
    { id: 'trends_content', component: 'Column', children: ['trend1', 'trend2', 'trend3'], gap: 'sm' },
    { id: 'trend1', component: 'Row', children: ['tr1_text', 'tr1_badge'], align: 'center', justify: 'between' },
    { id: 'tr1_text', component: 'Text', text: 'Tell me your industry to track trends' },
    { id: 'tr1_badge', component: 'Badge', text: 'Configure', variant: 'secondary' },
    { id: 'trend2', component: 'Row', children: ['tr2_text', 'tr2_badge'], align: 'center', justify: 'between' },
    { id: 'tr2_text', component: 'Text', text: 'I\'ll find content ideas daily' },
    { id: 'tr2_badge', component: 'Badge', text: 'Auto', variant: 'secondary' },
    { id: 'trend3', component: 'Row', children: ['tr3_text', 'tr3_badge'], align: 'center', justify: 'between' },
    { id: 'tr3_text', component: 'Text', text: 'Track competitor social accounts' },
    { id: 'tr3_badge', component: 'Badge', text: 'Optional', variant: 'secondary' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your industry, platforms, and posting goals. I\'ll build a content calendar, track engagement, and surface trending topics. Try: "I run a SaaS company and post on Twitter and LinkedIn"', variant: 'muted' },
  ],
  { metrics: { followers: '—', engagement: '—', posts: '0', topPost: '—' } },
)

// ---------------------------------------------------------------------------
// Release Manager
// ---------------------------------------------------------------------------
export const RELEASE_MANAGER_CANVAS = cs(
  'release_dashboard', 'Release Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'changelog_card', 'deploy_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'version_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🚀 Release Dashboard', variant: 'h2' },
    { id: 'version_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_unreleased', 'kpi_days', 'kpi_deploy', 'kpi_coverage'] },
    { id: 'kpi_unreleased', component: 'Metric', label: 'Unreleased PRs', value: { path: '/metrics/unreleased' } },
    { id: 'kpi_days', component: 'Metric', label: 'Days Since Release', value: { path: '/metrics/daysSince' } },
    { id: 'kpi_deploy', component: 'Metric', label: 'Deploy Status', value: { path: '/metrics/deployStatus' } },
    { id: 'kpi_coverage', component: 'Metric', label: 'Test Coverage', value: { path: '/metrics/coverage' } },
    { id: 'changelog_card', component: 'Card', title: 'Unreleased Changes', description: 'PRs merged since last release', child: 'changelog_placeholder' },
    { id: 'changelog_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll automatically track merged PRs and generate changelogs grouped by Features, Fixes, and Breaking Changes.', variant: 'muted' },
    { id: 'deploy_card', component: 'Card', title: 'Deployment Checklist', description: 'Pre-release steps', child: 'deploy_content' },
    { id: 'deploy_content', component: 'Column', children: ['step1', 'step2', 'step3'], gap: 'sm' },
    { id: 'step1', component: 'Row', children: ['s1_badge', 's1_text'], align: 'center', gap: 'sm' },
    { id: 's1_badge', component: 'Badge', text: '1', variant: 'secondary' },
    { id: 's1_text', component: 'Text', text: 'Review changelog and breaking changes' },
    { id: 'step2', component: 'Row', children: ['s2_badge', 's2_text'], align: 'center', gap: 'sm' },
    { id: 's2_badge', component: 'Badge', text: '2', variant: 'secondary' },
    { id: 's2_text', component: 'Text', text: 'Verify CI pipeline is green' },
    { id: 'step3', component: 'Row', children: ['s3_badge', 's3_text'], align: 'center', gap: 'sm' },
    { id: 's3_badge', component: 'Badge', text: '3', variant: 'secondary' },
    { id: 's3_text', component: 'Text', text: 'Tag release and notify stakeholders' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect my GitHub" and I\'ll track your repos, generate changelogs from merged PRs, and coordinate releases with deployment checklists.', variant: 'muted' },
  ],
  { metrics: { unreleased: '—', daysSince: '—', deployStatus: '—', coverage: '—' } },
)

// ---------------------------------------------------------------------------
// Hiring Pipeline
// ---------------------------------------------------------------------------
export const HIRING_PIPELINE_CANVAS = cs(
  'hiring_dashboard', 'Hiring Dashboard',
  [
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
    { id: 'applied_col', component: 'Card', title: '📩 Applied', child: 'applied_placeholder' },
    { id: 'applied_placeholder', component: 'Text', text: 'New applicants', variant: 'muted' },
    { id: 'screen_col', component: 'Card', title: '📞 Phone Screen', child: 'screen_placeholder' },
    { id: 'screen_placeholder', component: 'Text', text: 'Screening stage', variant: 'muted' },
    { id: 'interview_col', component: 'Card', title: '🗣️ Interview', child: 'interview_placeholder' },
    { id: 'interview_placeholder', component: 'Text', text: 'In interviews', variant: 'muted' },
    { id: 'offer_col', component: 'Card', title: '📋 Offer', child: 'offer_placeholder' },
    { id: 'offer_placeholder', component: 'Text', text: 'Offer extended', variant: 'muted' },
    { id: 'hired_col', component: 'Card', title: '🎉 Hired', child: 'hired_placeholder' },
    { id: 'hired_placeholder', component: 'Text', text: 'Welcome aboard!', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your open roles and interview process. I\'ll build a candidate pipeline, schedule interviews, collect feedback, and track time-to-hire metrics. Try: "We\'re hiring 2 engineers and 1 designer"', variant: 'muted' },
  ],
  { metrics: { candidates: '0', roles: '0', timeToHire: '—', offerRate: '—' } },
)

// ---------------------------------------------------------------------------
// Newsletter Curator
// ---------------------------------------------------------------------------
export const NEWSLETTER_CURATOR_CANVAS = cs(
  'newsletter_dashboard', 'Newsletter Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'articles_card', 'editions_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📰 Newsletter Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Configure topics to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_articles', 'kpi_editions', 'kpi_topics'] },
    { id: 'kpi_articles', component: 'Metric', label: 'Articles Curated', value: { path: '/metrics/articles' } },
    { id: 'kpi_editions', component: 'Metric', label: 'Editions Drafted', value: { path: '/metrics/editions' } },
    { id: 'kpi_topics', component: 'Metric', label: 'Topics Tracked', value: { path: '/metrics/topics' } },
    { id: 'articles_card', component: 'Card', title: 'Curated Articles', description: 'Best finds from your tracked topics', child: 'articles_content' },
    { id: 'articles_content', component: 'Column', children: ['art1', 'art2', 'art3'], gap: 'sm' },
    { id: 'art1', component: 'Row', children: ['a1_text', 'a1_badge'], align: 'center', justify: 'between' },
    { id: 'a1_text', component: 'Text', text: 'Articles will appear as I discover them' },
    { id: 'a1_badge', component: 'Badge', text: 'Auto', variant: 'secondary' },
    { id: 'art2', component: 'Row', children: ['a2_text', 'a2_badge'], align: 'center', justify: 'between' },
    { id: 'a2_text', component: 'Text', text: 'Each article gets a relevance score' },
    { id: 'a2_badge', component: 'Badge', text: 'Scored', variant: 'secondary' },
    { id: 'art3', component: 'Row', children: ['a3_text', 'a3_badge'], align: 'center', justify: 'between' },
    { id: 'a3_text', component: 'Text', text: 'Approve articles for the next edition' },
    { id: 'a3_badge', component: 'Badge', text: 'Review', variant: 'secondary' },
    { id: 'editions_card', component: 'Card', title: 'Recent Editions', description: 'Newsletter drafts and sent editions', child: 'editions_placeholder' },
    { id: 'editions_placeholder', component: 'Text', text: 'Once enough articles are curated, I\'ll draft an edition with an intro, curated links, and key takeaways for your review.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your newsletter topics and audience. I\'ll monitor the web, curate the best articles, and draft editions for your review. Try: "I write a weekly AI newsletter for developers"', variant: 'muted' },
  ],
  { metrics: { articles: '0', editions: '0', topics: '0' } },
)

// ---------------------------------------------------------------------------
// Competitor Intelligence
// ---------------------------------------------------------------------------
export const COMPETITOR_INTEL_CANVAS = cs(
  'competitor_dashboard', 'Competitor Intelligence',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'grid_card', 'changelog_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔍 Competitor Intelligence', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Add competitors to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_tracked', 'kpi_changes', 'kpi_alerts'] },
    { id: 'kpi_tracked', component: 'Metric', label: 'Competitors Tracked', value: { path: '/metrics/tracked' } },
    { id: 'kpi_changes', component: 'Metric', label: 'Changes This Week', value: { path: '/metrics/changes' } },
    { id: 'kpi_alerts', component: 'Metric', label: 'Alerts Triggered', value: { path: '/metrics/alerts' } },
    { id: 'grid_card', component: 'Card', title: 'Competitor Comparison', description: 'Side-by-side feature and pricing analysis', child: 'grid_placeholder' },
    { id: 'grid_placeholder', component: 'Text', text: 'Add your competitors and I\'ll build a comparison grid with features, pricing, and positioning. I\'ll update it automatically as things change.', variant: 'muted' },
    { id: 'changelog_card', component: 'Card', title: 'Change Log', description: 'Recent changes detected across competitors', child: 'changelog_content' },
    { id: 'changelog_content', component: 'Column', children: ['cl1', 'cl2'], gap: 'sm' },
    { id: 'cl1', component: 'Row', children: ['cl1_badge', 'cl1_text'], align: 'center', gap: 'sm' },
    { id: 'cl1_badge', component: 'Badge', text: 'Pricing', variant: 'default' },
    { id: 'cl1_text', component: 'Text', text: 'Changes will be logged automatically', variant: 'muted' },
    { id: 'cl2', component: 'Row', children: ['cl2_badge', 'cl2_text'], align: 'center', gap: 'sm' },
    { id: 'cl2_badge', component: 'Badge', text: 'Features', variant: 'secondary' },
    { id: 'cl2_text', component: 'Text', text: 'New product launches and updates', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me which competitors to monitor and I\'ll track their pricing, features, blog posts, and job postings. Try: "Monitor Notion, Coda, and Airtable"', variant: 'muted' },
  ],
  { metrics: { tracked: '0', changes: '0', alerts: '0' } },
)

// ---------------------------------------------------------------------------
// API Health Monitor
// ---------------------------------------------------------------------------
export const API_HEALTH_MONITOR_CANVAS = cs(
  'api_health_dashboard', 'API Health Monitor',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'status_card', 'incidents_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'all_ok_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '💓 API Health Monitor', variant: 'h2' },
    { id: 'all_ok_badge', component: 'Badge', text: 'No endpoints configured', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_endpoints', 'kpi_uptime', 'kpi_latency', 'kpi_incidents'] },
    { id: 'kpi_endpoints', component: 'Metric', label: 'Endpoints', value: { path: '/metrics/endpoints' } },
    { id: 'kpi_uptime', component: 'Metric', label: 'Uptime', value: { path: '/metrics/uptime' } },
    { id: 'kpi_latency', component: 'Metric', label: 'Avg Latency', value: { path: '/metrics/latency' }, unit: 'ms' },
    { id: 'kpi_incidents', component: 'Metric', label: 'Incidents (24h)', value: { path: '/metrics/incidents' } },
    { id: 'status_card', component: 'Card', title: 'Endpoint Status', description: 'Real-time health of monitored APIs', child: 'status_content' },
    { id: 'status_content', component: 'Column', children: ['ep1', 'ep2', 'ep3'], gap: 'sm' },
    { id: 'ep1', component: 'Row', children: ['ep1_badge', 'ep1_text', 'ep1_latency'], align: 'center', justify: 'between' },
    { id: 'ep1_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'ep1_text', component: 'Text', text: 'Endpoint 1' },
    { id: 'ep1_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'ep2', component: 'Row', children: ['ep2_badge', 'ep2_text', 'ep2_latency'], align: 'center', justify: 'between' },
    { id: 'ep2_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'ep2_text', component: 'Text', text: 'Endpoint 2' },
    { id: 'ep2_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'ep3', component: 'Row', children: ['ep3_badge', 'ep3_text', 'ep3_latency'], align: 'center', justify: 'between' },
    { id: 'ep3_badge', component: 'Badge', text: '●', variant: 'secondary' },
    { id: 'ep3_text', component: 'Text', text: 'Endpoint 3' },
    { id: 'ep3_latency', component: 'Text', text: 'Not configured', variant: 'muted' },
    { id: 'incidents_card', component: 'Card', title: 'Recent Incidents', description: 'Failed health checks and degradations', child: 'incidents_placeholder' },
    { id: 'incidents_placeholder', component: 'Text', text: 'Incidents will be logged here with timestamps, affected endpoints, error codes, and duration. I check every 5 minutes.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Share your API health check URLs and I\'ll start monitoring. I check every 5 minutes, track latency trends, and alert immediately on failures. Try: "Monitor https://api.example.com/health"', variant: 'muted' },
  ],
  { metrics: { endpoints: '0', uptime: '—', latency: '—', incidents: '0' } },
)

// ---------------------------------------------------------------------------
// Expense Manager
// ---------------------------------------------------------------------------
export const EXPENSE_MANAGER_CANVAS = cs(
  'expense_dashboard', 'Expense Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'breakdown_card', 'transactions_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'month_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🧾 Expense Dashboard', variant: 'h2' },
    { id: 'month_badge', component: 'Badge', text: 'Ready to track', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_spent', 'kpi_remaining', 'kpi_largest', 'kpi_txns'] },
    { id: 'kpi_spent', component: 'Metric', label: 'Spent (Month)', value: { path: '/metrics/spent' }, unit: '$' },
    { id: 'kpi_remaining', component: 'Metric', label: 'Budget Left', value: { path: '/metrics/remaining' }, unit: '$' },
    { id: 'kpi_largest', component: 'Metric', label: 'Largest Category', value: { path: '/metrics/largest' } },
    { id: 'kpi_txns', component: 'Metric', label: 'Transactions', value: { path: '/metrics/txns' } },
    { id: 'breakdown_card', component: 'Card', title: 'Spending Breakdown', description: 'Budget vs actual by category', child: 'breakdown_content' },
    { id: 'breakdown_content', component: 'Column', children: ['cat1', 'cat2', 'cat3'], gap: 'sm' },
    { id: 'cat1', component: 'Row', children: ['c1_text', 'c1_badge'], align: 'center', justify: 'between' },
    { id: 'c1_text', component: 'Text', text: 'Software & Tools' },
    { id: 'c1_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'cat2', component: 'Row', children: ['c2_text', 'c2_badge'], align: 'center', justify: 'between' },
    { id: 'c2_text', component: 'Text', text: 'Marketing & Ads' },
    { id: 'c2_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'cat3', component: 'Row', children: ['c3_text', 'c3_badge'], align: 'center', justify: 'between' },
    { id: 'c3_text', component: 'Text', text: 'Travel & Entertainment' },
    { id: 'c3_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'transactions_card', component: 'Card', title: 'Recent Transactions', description: 'All logged expenses', child: 'txn_placeholder' },
    { id: 'txn_placeholder', component: 'Text', text: 'Tell me your budget categories and I\'ll build an expense tracker with budget alerts. You can log expenses via chat or connect Stripe for automatic tracking.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your budget categories and monthly limits. I\'ll track spending, alert on overages, and generate monthly reports. Try: "My budget is $5k/mo split across software, marketing, and travel"', variant: 'muted' },
  ],
  { metrics: { spent: '—', remaining: '—', largest: '—', txns: '0' } },
)

// ---------------------------------------------------------------------------
// Fitness Coach
// ---------------------------------------------------------------------------
export const FITNESS_COACH_CANVAS = cs(
  'fitness_dashboard', 'Fitness Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'schedule_card', 'log_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'streak_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '💪 Fitness Dashboard', variant: 'h2' },
    { id: 'streak_badge', component: 'Badge', text: 'Let\'s get started!', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_workouts', 'kpi_streak', 'kpi_volume', 'kpi_minutes'] },
    { id: 'kpi_workouts', component: 'Metric', label: 'Workouts (Week)', value: { path: '/metrics/workouts' } },
    { id: 'kpi_streak', component: 'Metric', label: 'Current Streak', value: { path: '/metrics/streak' }, unit: 'days' },
    { id: 'kpi_volume', component: 'Metric', label: 'Total Volume', value: { path: '/metrics/volume' }, unit: 'lbs' },
    { id: 'kpi_minutes', component: 'Metric', label: 'Active Minutes', value: { path: '/metrics/minutes' } },
    { id: 'schedule_card', component: 'Card', title: 'This Week\'s Plan', description: 'Your workout schedule', child: 'schedule_content' },
    { id: 'schedule_content', component: 'Column', children: ['day1', 'day2', 'day3', 'day4'], gap: 'sm' },
    { id: 'day1', component: 'Row', children: ['d1_text', 'd1_badge'], align: 'center', justify: 'between' },
    { id: 'd1_text', component: 'Text', text: 'Monday — Upper Body' },
    { id: 'd1_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'day2', component: 'Row', children: ['d2_text', 'd2_badge'], align: 'center', justify: 'between' },
    { id: 'd2_text', component: 'Text', text: 'Wednesday — Lower Body' },
    { id: 'd2_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'day3', component: 'Row', children: ['d3_text', 'd3_badge'], align: 'center', justify: 'between' },
    { id: 'd3_text', component: 'Text', text: 'Friday — Cardio & Core' },
    { id: 'd3_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'day4', component: 'Row', children: ['d4_text', 'd4_badge'], align: 'center', justify: 'between' },
    { id: 'd4_text', component: 'Text', text: 'Sunday — Active Recovery' },
    { id: 'd4_badge', component: 'Badge', text: 'Example', variant: 'secondary' },
    { id: 'log_card', component: 'Card', title: 'Exercise Log', description: 'Track your workouts', child: 'log_placeholder' },
    { id: 'log_placeholder', component: 'Text', text: 'Log workouts via chat: "Did 3x10 bench press at 135lbs" and I\'ll track everything with progress charts.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your fitness goals and available equipment. I\'ll create a personalized workout plan, track your progress, and celebrate your streaks. Try: "I want to build strength, 4 days/week, home gym"', variant: 'muted' },
  ],
  { metrics: { workouts: '0', streak: '0', volume: '0', minutes: '0' } },
)

// ---------------------------------------------------------------------------
// Daily Journal
// ---------------------------------------------------------------------------
export const DAILY_JOURNAL_CANVAS = cs(
  'journal_dashboard', 'Journal Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'today_card', 'entries_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'streak_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📓 Daily Journal', variant: 'h2' },
    { id: 'streak_badge', component: 'Badge', text: 'Start your first entry', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_streak', 'kpi_entries', 'kpi_mood'] },
    { id: 'kpi_streak', component: 'Metric', label: 'Journal Streak', value: { path: '/metrics/streak' }, unit: 'days' },
    { id: 'kpi_entries', component: 'Metric', label: 'Total Entries', value: { path: '/metrics/entries' } },
    { id: 'kpi_mood', component: 'Metric', label: 'Avg Mood', value: { path: '/metrics/mood' } },
    { id: 'today_card', component: 'Card', title: 'Today\'s Reflection', description: 'How are you feeling today?', child: 'today_content' },
    { id: 'today_content', component: 'Column', children: ['prompt_text', 'mood_row'], gap: 'md' },
    { id: 'prompt_text', component: 'Text', text: 'Take a moment to reflect on your day. What went well? What are you grateful for? What would you do differently?', variant: 'muted' },
    { id: 'mood_row', component: 'Row', children: ['m1', 'm2', 'm3', 'm4', 'm5'], justify: 'center', gap: 'md' },
    { id: 'm1', component: 'Text', text: '😊', variant: 'h3' },
    { id: 'm2', component: 'Text', text: '🙂', variant: 'h3' },
    { id: 'm3', component: 'Text', text: '😐', variant: 'h3' },
    { id: 'm4', component: 'Text', text: '😔', variant: 'h3' },
    { id: 'm5', component: 'Text', text: '😤', variant: 'h3' },
    { id: 'entries_card', component: 'Card', title: 'Recent Entries', description: 'Your journal history', child: 'entries_placeholder' },
    { id: 'entries_placeholder', component: 'Text', text: 'Your journal entries will build a beautiful timeline here. I\'ll track mood patterns and surface insights over time.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Start journaling in any way that feels natural:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Just tell me how your day went' },
    { id: 'opt2', component: 'Text', text: '• I\'ll ask you a thoughtful reflection question each evening' },
    { id: 'opt3', component: 'Text', text: '• I\'ll track mood, gratitude, and themes over time' },
  ],
  { metrics: { streak: '0', entries: '0', mood: '—' } },
)

// ---------------------------------------------------------------------------
// Market Watch
// ---------------------------------------------------------------------------
export const MARKET_WATCH_CANVAS = cs(
  'market_dashboard', 'Market Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'portfolio_card', 'news_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'market_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📈 Market Watch', variant: 'h2' },
    { id: 'market_badge', component: 'Badge', text: 'Add assets to track', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_value', 'kpi_pnl', 'kpi_best', 'kpi_worst'] },
    { id: 'kpi_value', component: 'Metric', label: 'Portfolio Value', value: { path: '/metrics/value' }, unit: '$' },
    { id: 'kpi_pnl', component: 'Metric', label: 'Daily P&L', value: { path: '/metrics/pnl' }, unit: '$' },
    { id: 'kpi_best', component: 'Metric', label: 'Best Performer', value: { path: '/metrics/best' } },
    { id: 'kpi_worst', component: 'Metric', label: 'Worst Performer', value: { path: '/metrics/worst' } },
    { id: 'portfolio_card', component: 'Card', title: 'Watchlist', description: 'Your tracked assets', child: 'portfolio_content' },
    { id: 'portfolio_content', component: 'Column', children: ['asset1', 'asset2', 'asset3'], gap: 'sm' },
    { id: 'asset1', component: 'Row', children: ['a1_text', 'a1_badge'], align: 'center', justify: 'between' },
    { id: 'a1_text', component: 'Text', text: 'Tell me which stocks or crypto to track' },
    { id: 'a1_badge', component: 'Badge', text: 'Setup', variant: 'secondary' },
    { id: 'asset2', component: 'Row', children: ['a2_text', 'a2_badge'], align: 'center', justify: 'between' },
    { id: 'a2_text', component: 'Text', text: 'I\'ll check prices every 30 minutes' },
    { id: 'a2_badge', component: 'Badge', text: 'Auto', variant: 'secondary' },
    { id: 'asset3', component: 'Row', children: ['a3_text', 'a3_badge'], align: 'center', justify: 'between' },
    { id: 'a3_text', component: 'Text', text: 'Set custom price alert thresholds' },
    { id: 'a3_badge', component: 'Badge', text: 'Alerts', variant: 'secondary' },
    { id: 'news_card', component: 'Card', title: 'Market News', description: 'Breaking financial news for your assets', child: 'news_placeholder' },
    { id: 'news_placeholder', component: 'Text', text: 'Once you tell me what to track, I\'ll surface relevant market news, price movements, and send alerts when thresholds are hit.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your watchlist and alert preferences. I\'ll track prices, surface relevant news, and alert on big moves. Try: "Track AAPL, MSFT, BTC and alert me on >5% daily moves"', variant: 'muted' },
  ],
  { metrics: { value: '—', pnl: '—', best: '—', worst: '—' } },
)

// ---------------------------------------------------------------------------
// Code Review Assistant
// ---------------------------------------------------------------------------
export const CODE_REVIEW_ASSISTANT_CANVAS = cs(
  'code_review_dashboard', 'Code Review Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'queue_card', 'stats_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔬 Code Review Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Connect GitHub to start', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_reviewed', 'kpi_issues', 'kpi_time', 'kpi_quality'] },
    { id: 'kpi_reviewed', component: 'Metric', label: 'PRs Reviewed', value: { path: '/metrics/reviewed' } },
    { id: 'kpi_issues', component: 'Metric', label: 'Issues Found', value: { path: '/metrics/issues' } },
    { id: 'kpi_time', component: 'Metric', label: 'Avg Review Time', value: { path: '/metrics/reviewTime' } },
    { id: 'kpi_quality', component: 'Metric', label: 'Quality Score', value: { path: '/metrics/quality' } },
    { id: 'queue_card', component: 'Card', title: 'Review Queue', description: 'PRs awaiting review', child: 'queue_placeholder' },
    { id: 'queue_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll monitor new PRs, auto-review small changes, and post summaries with categorized findings (bugs, security, performance).', variant: 'muted' },
    { id: 'stats_card', component: 'Card', title: 'Review Insights', description: 'Common issues found across PRs', child: 'stats_content' },
    { id: 'stats_content', component: 'Column', children: ['cat1', 'cat2', 'cat3', 'cat4'], gap: 'sm' },
    { id: 'cat1', component: 'Row', children: ['c1_badge', 'c1_text'], align: 'center', gap: 'sm' },
    { id: 'c1_badge', component: 'Badge', text: 'Bugs', variant: 'destructive' },
    { id: 'c1_text', component: 'Text', text: 'Logic errors and edge cases', variant: 'muted' },
    { id: 'cat2', component: 'Row', children: ['c2_badge', 'c2_text'], align: 'center', gap: 'sm' },
    { id: 'c2_badge', component: 'Badge', text: 'Security', variant: 'default' },
    { id: 'c2_text', component: 'Text', text: 'Vulnerabilities and auth issues', variant: 'muted' },
    { id: 'cat3', component: 'Row', children: ['c3_badge', 'c3_text'], align: 'center', gap: 'sm' },
    { id: 'c3_badge', component: 'Badge', text: 'Performance', variant: 'secondary' },
    { id: 'c3_text', component: 'Text', text: 'N+1 queries and inefficiencies', variant: 'muted' },
    { id: 'cat4', component: 'Row', children: ['c4_badge', 'c4_text'], align: 'center', gap: 'sm' },
    { id: 'c4_badge', component: 'Badge', text: 'Style', variant: 'outline' },
    { id: 'c4_text', component: 'Text', text: 'Naming, patterns, and conventions', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Say "Connect my GitHub" and I\'ll start reviewing PRs. I\'ll focus on bugs, security, and performance while being constructive and educational in my feedback.', variant: 'muted' },
  ],
  { metrics: { reviewed: '0', issues: '0', reviewTime: '—', quality: '—' } },
)

// ---------------------------------------------------------------------------
// Client Onboarding
// ---------------------------------------------------------------------------
export const CLIENT_ONBOARDING_CANVAS = cs(
  'onboarding_dashboard', 'Client Onboarding',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'pipeline_card', 'checklist_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🤝 Client Onboarding', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Ready to set up', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_active', 'kpi_avg', 'kpi_overdue', 'kpi_completion'] },
    { id: 'kpi_active', component: 'Metric', label: 'Onboarding Now', value: { path: '/metrics/active' } },
    { id: 'kpi_avg', component: 'Metric', label: 'Avg Activation', value: { path: '/metrics/avgTime' }, unit: 'days' },
    { id: 'kpi_overdue', component: 'Metric', label: 'Overdue Steps', value: { path: '/metrics/overdue' } },
    { id: 'kpi_completion', component: 'Metric', label: 'Completion Rate', value: { path: '/metrics/completion' } },
    { id: 'pipeline_card', component: 'Card', title: 'Client Pipeline', description: 'Clients in onboarding', child: 'pipeline_placeholder' },
    { id: 'pipeline_placeholder', component: 'Text', text: 'Add clients and I\'ll track them through your onboarding stages. Each client gets a checklist, timeline, and automatic follow-up reminders.', variant: 'muted' },
    { id: 'checklist_card', component: 'Card', title: 'Default Checklist', description: 'Steps for new clients', child: 'checklist_content' },
    { id: 'checklist_content', component: 'Column', children: ['step1', 'step2', 'step3', 'step4', 'step5'], gap: 'sm' },
    { id: 'step1', component: 'Row', children: ['s1_badge', 's1_text'], align: 'center', gap: 'sm' },
    { id: 's1_badge', component: 'Badge', text: '1', variant: 'secondary' },
    { id: 's1_text', component: 'Text', text: 'Send welcome email' },
    { id: 'step2', component: 'Row', children: ['s2_badge', 's2_text'], align: 'center', gap: 'sm' },
    { id: 's2_badge', component: 'Badge', text: '2', variant: 'secondary' },
    { id: 's2_text', component: 'Text', text: 'Schedule kickoff call' },
    { id: 'step3', component: 'Row', children: ['s3_badge', 's3_text'], align: 'center', gap: 'sm' },
    { id: 's3_badge', component: 'Badge', text: '3', variant: 'secondary' },
    { id: 's3_text', component: 'Text', text: 'Collect required documents' },
    { id: 'step4', component: 'Row', children: ['s4_badge', 's4_text'], align: 'center', gap: 'sm' },
    { id: 's4_badge', component: 'Badge', text: '4', variant: 'secondary' },
    { id: 's4_text', component: 'Text', text: 'Complete training session' },
    { id: 'step5', component: 'Row', children: ['s5_badge', 's5_text'], align: 'center', gap: 'sm' },
    { id: 's5_badge', component: 'Badge', text: '5', variant: 'secondary' },
    { id: 's5_text', component: 'Text', text: 'Go live!' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me your onboarding process and I\'ll build a pipeline tracker. I\'ll manage checklists, send reminders, and track time-to-activation. Try: "We onboard enterprise clients in 5 steps over 14 days"', variant: 'muted' },
  ],
  { metrics: { active: '0', avgTime: '—', overdue: '0', completion: '—' } },
)

// ---------------------------------------------------------------------------
// Travel Planner
// ---------------------------------------------------------------------------
export const TRAVEL_PLANNER_CANVAS = cs(
  'travel_dashboard', 'Travel Planner',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'itinerary_card', 'bookings_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '✈️ Travel Planner', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Plan your next trip', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_trips', 'kpi_budget', 'kpi_bookings', 'kpi_countdown'] },
    { id: 'kpi_trips', component: 'Metric', label: 'Upcoming Trips', value: { path: '/metrics/trips' } },
    { id: 'kpi_budget', component: 'Metric', label: 'Total Budget', value: { path: '/metrics/budget' }, unit: '$' },
    { id: 'kpi_bookings', component: 'Metric', label: 'Confirmed', value: { path: '/metrics/bookings' } },
    { id: 'kpi_countdown', component: 'Metric', label: 'Days Until Next', value: { path: '/metrics/countdown' } },
    { id: 'itinerary_card', component: 'Card', title: 'Itinerary', description: 'Day-by-day trip schedule', child: 'itinerary_content' },
    { id: 'itinerary_content', component: 'Column', children: ['itin1', 'itin2', 'itin3'], gap: 'sm' },
    { id: 'itin1', component: 'Row', children: ['i1_badge', 'i1_text'], align: 'center', gap: 'sm' },
    { id: 'i1_badge', component: 'Badge', text: 'Day 1', variant: 'default' },
    { id: 'i1_text', component: 'Text', text: 'Arrival, check-in, explore neighborhood', variant: 'muted' },
    { id: 'itin2', component: 'Row', children: ['i2_badge', 'i2_text'], align: 'center', gap: 'sm' },
    { id: 'i2_badge', component: 'Badge', text: 'Day 2', variant: 'default' },
    { id: 'i2_text', component: 'Text', text: 'Top attractions and local cuisine', variant: 'muted' },
    { id: 'itin3', component: 'Row', children: ['i3_badge', 'i3_text'], align: 'center', gap: 'sm' },
    { id: 'i3_badge', component: 'Badge', text: 'Day 3', variant: 'default' },
    { id: 'i3_text', component: 'Text', text: 'Day trip or unique experiences', variant: 'muted' },
    { id: 'bookings_card', component: 'Card', title: 'Bookings', description: 'Flights, hotels, and activities', child: 'bookings_placeholder' },
    { id: 'bookings_placeholder', component: 'Text', text: 'I\'ll track all your bookings with confirmation numbers, costs, and dates. Forward booking emails to me for automatic import.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_text' },
    { id: 'gs_text', component: 'Text', text: 'Tell me where you want to go and I\'ll research the destination, build an itinerary, and track your bookings and budget. Try: "Plan a 5-day trip to Tokyo in April, mid-range budget"', variant: 'muted' },
  ],
  { metrics: { trips: '0', budget: '—', bookings: '0', countdown: '—' } },
)

// ---------------------------------------------------------------------------
// Email → Slack Alert
// ---------------------------------------------------------------------------
export const EMAIL_SLACK_ALERT_CANVAS = cs(
  'email_alert_dashboard', 'Email Alert Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'rules_card', 'alerts_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📨 Email → Slack Alerts', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No email connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_alerts', 'kpi_senders', 'kpi_last'] },
    { id: 'kpi_alerts', component: 'Metric', label: 'Alerts Today', value: { path: '/metrics/alertsToday' } },
    { id: 'kpi_senders', component: 'Metric', label: 'Senders Tracked', value: { path: '/metrics/sendersTracked' } },
    { id: 'kpi_last', component: 'Metric', label: 'Last Checked', value: { path: '/metrics/lastChecked' } },
    { id: 'rules_card', component: 'Card', title: 'Alert Rules', description: 'Configure which senders trigger Slack alerts', child: 'rules_content' },
    { id: 'rules_content', component: 'Column', children: ['rule1', 'rule2', 'rule3'], gap: 'sm' },
    { id: 'rule1', component: 'Row', children: ['r1_badge', 'r1_text', 'r1_channel'], align: 'center', justify: 'between' },
    { id: 'r1_badge', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'r1_text', component: 'Text', text: '@ceo.com, @investor.com' },
    { id: 'r1_channel', component: 'Text', text: '#urgent', variant: 'muted' },
    { id: 'rule2', component: 'Row', children: ['r2_badge', 'r2_text', 'r2_channel'], align: 'center', justify: 'between' },
    { id: 'r2_badge', component: 'Badge', text: 'Normal', variant: 'default' },
    { id: 'r2_text', component: 'Text', text: '@client.com, @vendor.com' },
    { id: 'r2_channel', component: 'Text', text: '#general', variant: 'muted' },
    { id: 'rule3', component: 'Row', children: ['r3_badge', 'r3_text', 'r3_channel'], align: 'center', justify: 'between' },
    { id: 'r3_badge', component: 'Badge', text: 'Low', variant: 'secondary' },
    { id: 'r3_text', component: 'Text', text: 'newsletters, notifications' },
    { id: 'r3_channel', component: 'Text', text: 'Daily digest', variant: 'muted' },
    { id: 'alerts_card', component: 'Card', title: 'Recent Alerts', description: 'Latest forwarded emails', child: 'alerts_placeholder' },
    { id: 'alerts_placeholder', component: 'Text', text: 'Alerts will appear here once you connect Gmail and Slack. Each forwarded email shows sender, subject, urgency, and delivery status.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up email-to-Slack alerts:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect Gmail and Slack" to link both accounts' },
    { id: 'opt2', component: 'Text', text: '• Then: "Alert me when I get emails from @acme.com in #deals"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll check every 5 minutes and forward matching emails to Slack' },
  ],
  { metrics: { alertsToday: '0', sendersTracked: '0', lastChecked: 'Never' } },
)

// ---------------------------------------------------------------------------
// Developer Activity Dashboard
// ---------------------------------------------------------------------------
export const DEV_ACTIVITY_CANVAS = cs(
  'dev_activity_dashboard', 'Developer Activity',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'team_card', 'feed_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📊 Developer Activity', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_commits', 'kpi_prs', 'kpi_reviews', 'kpi_active'] },
    { id: 'kpi_commits', component: 'Metric', label: 'Commits Today', value: { path: '/metrics/commitsToday' } },
    { id: 'kpi_prs', component: 'Metric', label: 'PRs Merged', value: { path: '/metrics/prsMerged' } },
    { id: 'kpi_reviews', component: 'Metric', label: 'Reviews Done', value: { path: '/metrics/reviewsDone' } },
    { id: 'kpi_active', component: 'Metric', label: 'Active Devs', value: { path: '/metrics/activeDevs' } },
    { id: 'team_card', component: 'Card', title: 'Team Breakdown', description: 'Per-developer activity for today', child: 'team_placeholder' },
    { id: 'team_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll show per-developer commit counts, PR activity, and review stats here.', variant: 'muted' },
    { id: 'feed_card', component: 'Card', title: 'Activity Feed', description: 'Recent commits, PRs, and reviews', child: 'feed_placeholder' },
    { id: 'feed_placeholder', component: 'Text', text: 'A chronological feed of commits, PR events, and reviews will appear here once GitHub is connected.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up your activity dashboard:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect my GitHub" to link your account' },
    { id: 'opt2', component: 'Text', text: '• Tell me which repos to track: "Watch org/repo1 and org/repo2"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll build a live activity feed with per-developer breakdowns' },
  ],
  { metrics: { commitsToday: '—', prsMerged: '—', reviewsDone: '—', activeDevs: '—' } },
)

// ---------------------------------------------------------------------------
// Standup Summary Generator
// ---------------------------------------------------------------------------
export const STANDUP_GENERATOR_CANVAS = cs(
  'standup_dashboard', 'Standup Summary',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'blockers_card', 'summary_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🗓️ Standup Summary', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Not yet generated', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_active', 'kpi_prs', 'kpi_commits', 'kpi_blockers'] },
    { id: 'kpi_active', component: 'Metric', label: 'Team Active', value: { path: '/metrics/teamActive' } },
    { id: 'kpi_prs', component: 'Metric', label: 'PRs in Flight', value: { path: '/metrics/prsInFlight' } },
    { id: 'kpi_commits', component: 'Metric', label: 'Commits (24h)', value: { path: '/metrics/commits24h' } },
    { id: 'kpi_blockers', component: 'Metric', label: 'Blockers', value: { path: '/metrics/blockers' } },
    { id: 'blockers_card', component: 'Card', title: '🚧 Blockers', description: 'Items requiring attention', child: 'blockers_placeholder' },
    { id: 'blockers_placeholder', component: 'Text', text: 'Blockers like stale PRs and failing CI will be highlighted here once GitHub is connected.', variant: 'muted' },
    { id: 'summary_card', component: 'Card', title: 'Today\'s Summary', description: 'Auto-generated from GitHub activity', child: 'summary_placeholder' },
    { id: 'summary_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll automatically generate standup summaries each morning. Each team member\'s Done / In Progress / Blockers will be compiled from their actual commits and PRs.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up automatic standups:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect GitHub and Slack" to link both accounts' },
    { id: 'opt2', component: 'Text', text: '• Tell me your team: "Track @alice, @bob, and @carol"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll generate and post standup summaries every morning at 9 AM' },
  ],
  { metrics: { teamActive: '—', prsInFlight: '—', commits24h: '—', blockers: '—' } },
)

// ---------------------------------------------------------------------------
// Slack Mention Monitor
// ---------------------------------------------------------------------------
export const SLACK_MONITOR_CANVAS = cs(
  'mention_dashboard', 'Slack Monitor',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'mentions_card', 'rules_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '👁️ Slack Monitor', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No Slack connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_unread', 'kpi_channels', 'kpi_keywords', 'kpi_today'] },
    { id: 'kpi_unread', component: 'Metric', label: 'Unread Mentions', value: { path: '/metrics/unreadMentions' } },
    { id: 'kpi_channels', component: 'Metric', label: 'Channels Watched', value: { path: '/metrics/channelsWatched' } },
    { id: 'kpi_keywords', component: 'Metric', label: 'Keywords Tracked', value: { path: '/metrics/keywordsTracked' } },
    { id: 'kpi_today', component: 'Metric', label: 'Alerts Today', value: { path: '/metrics/alertsToday' } },
    { id: 'mentions_card', component: 'Card', title: 'Recent Mentions', description: 'Latest @mentions and keyword matches', child: 'mentions_placeholder' },
    { id: 'mentions_placeholder', component: 'Text', text: 'Connect Slack and mentions, keyword matches, and watched channel activity will appear here categorized by urgency.', variant: 'muted' },
    { id: 'rules_card', component: 'Card', title: 'Watch Rules', description: 'Configure what to monitor', child: 'rules_placeholder' },
    { id: 'rules_placeholder', component: 'Text', text: 'Watch rules will appear here. You can add keywords, channels, and priority people to monitor. Each rule can be set to Urgent, Normal, or FYI priority.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up Slack monitoring:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect Slack" to link your workspace' },
    { id: 'opt2', component: 'Text', text: '• Configure: "Watch for mentions of \'production\' and \'outage\'"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll check every 10 minutes and alert you on urgent mentions' },
  ],
  { metrics: { unreadMentions: '0', channelsWatched: '0', keywordsTracked: '0', alertsToday: '0' } },
)

// ---------------------------------------------------------------------------
// Git Commit Insights
// ---------------------------------------------------------------------------
export const GIT_INSIGHTS_CANVAS = cs(
  'git_insights_dashboard', 'Engineering Insights',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'team_card', 'pr_aging_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'period_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔍 Engineering Insights', variant: 'h2' },
    { id: 'period_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_commits', 'kpi_cycle', 'kpi_top', 'kpi_prs'] },
    { id: 'kpi_commits', component: 'Metric', label: 'Weekly Commits', value: { path: '/metrics/weeklyCommits' } },
    { id: 'kpi_cycle', component: 'Metric', label: 'Avg PR Cycle', value: { path: '/metrics/avgCycleTime' } },
    { id: 'kpi_top', component: 'Metric', label: 'Top Reviewer', value: { path: '/metrics/topReviewer' } },
    { id: 'kpi_prs', component: 'Metric', label: 'Active PRs', value: { path: '/metrics/activePrs' } },
    { id: 'team_card', component: 'Card', title: 'Team Leaderboard', description: 'Weekly contribution metrics', child: 'team_placeholder' },
    { id: 'team_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll show a team leaderboard with commits, PRs merged, and reviews given per developer.', variant: 'muted' },
    { id: 'pr_aging_card', component: 'Card', title: 'PR Aging', description: 'Open PRs sorted by age', child: 'pr_aging_placeholder' },
    { id: 'pr_aging_placeholder', component: 'Text', text: 'Open PRs older than 3 days without review will be flagged here. Connect GitHub to start tracking.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up engineering insights:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect GitHub" to link your account' },
    { id: 'opt2', component: 'Text', text: '• Tell me your repos and team: "Track myorg/api and myorg/web"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll compute PR cycle times, code churn, and team velocity weekly' },
  ],
  { metrics: { weeklyCommits: '—', avgCycleTime: '—', topReviewer: '—', activePrs: '—' } },
)

// ---------------------------------------------------------------------------
// Email → Slack Alert
// ---------------------------------------------------------------------------
export const EMAIL_SLACK_ALERT_CANVAS = cs(
  'email_alert_dashboard', 'Email Alert Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'rules_card', 'alerts_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📨 Email → Slack Alerts', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No email connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 3, children: ['kpi_alerts', 'kpi_senders', 'kpi_last'] },
    { id: 'kpi_alerts', component: 'Metric', label: 'Alerts Today', value: { path: '/metrics/alertsToday' } },
    { id: 'kpi_senders', component: 'Metric', label: 'Senders Tracked', value: { path: '/metrics/sendersTracked' } },
    { id: 'kpi_last', component: 'Metric', label: 'Last Checked', value: { path: '/metrics/lastChecked' } },
    { id: 'rules_card', component: 'Card', title: 'Alert Rules', description: 'Configure which senders trigger Slack alerts', child: 'rules_content' },
    { id: 'rules_content', component: 'Column', children: ['rule1', 'rule2', 'rule3'], gap: 'sm' },
    { id: 'rule1', component: 'Row', children: ['r1_badge', 'r1_text', 'r1_channel'], align: 'center', justify: 'between' },
    { id: 'r1_badge', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'r1_text', component: 'Text', text: '@ceo.com, @investor.com' },
    { id: 'r1_channel', component: 'Text', text: '#urgent', variant: 'muted' },
    { id: 'rule2', component: 'Row', children: ['r2_badge', 'r2_text', 'r2_channel'], align: 'center', justify: 'between' },
    { id: 'r2_badge', component: 'Badge', text: 'Normal', variant: 'default' },
    { id: 'r2_text', component: 'Text', text: '@client.com, @vendor.com' },
    { id: 'r2_channel', component: 'Text', text: '#general', variant: 'muted' },
    { id: 'rule3', component: 'Row', children: ['r3_badge', 'r3_text', 'r3_channel'], align: 'center', justify: 'between' },
    { id: 'r3_badge', component: 'Badge', text: 'Low', variant: 'secondary' },
    { id: 'r3_text', component: 'Text', text: 'newsletters, notifications' },
    { id: 'r3_channel', component: 'Text', text: 'Daily digest', variant: 'muted' },
    { id: 'alerts_card', component: 'Card', title: 'Recent Alerts', description: 'Latest forwarded emails', child: 'alerts_placeholder' },
    { id: 'alerts_placeholder', component: 'Text', text: 'Alerts will appear here once you connect Gmail and Slack. Each forwarded email shows sender, subject, urgency, and delivery status.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up email-to-Slack alerts:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect Gmail and Slack" to link both accounts' },
    { id: 'opt2', component: 'Text', text: '• Then: "Alert me when I get emails from @acme.com in #deals"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll check every 5 minutes and forward matching emails to Slack' },
  ],
  { metrics: { alertsToday: '0', sendersTracked: '0', lastChecked: 'Never' } },
)

// ---------------------------------------------------------------------------
// Developer Activity Dashboard
// ---------------------------------------------------------------------------
export const DEV_ACTIVITY_CANVAS = cs(
  'dev_activity_dashboard', 'Developer Activity',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'team_card', 'feed_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '📊 Developer Activity', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_commits', 'kpi_prs', 'kpi_reviews', 'kpi_active'] },
    { id: 'kpi_commits', component: 'Metric', label: 'Commits Today', value: { path: '/metrics/commitsToday' } },
    { id: 'kpi_prs', component: 'Metric', label: 'PRs Merged', value: { path: '/metrics/prsMerged' } },
    { id: 'kpi_reviews', component: 'Metric', label: 'Reviews Done', value: { path: '/metrics/reviewsDone' } },
    { id: 'kpi_active', component: 'Metric', label: 'Active Devs', value: { path: '/metrics/activeDevs' } },
    { id: 'team_card', component: 'Card', title: 'Team Breakdown', description: 'Per-developer activity for today', child: 'team_placeholder' },
    { id: 'team_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll show per-developer commit counts, PR activity, and review stats here.', variant: 'muted' },
    { id: 'feed_card', component: 'Card', title: 'Activity Feed', description: 'Recent commits, PRs, and reviews', child: 'feed_placeholder' },
    { id: 'feed_placeholder', component: 'Text', text: 'A chronological feed of commits, PR events, and reviews will appear here once GitHub is connected.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up your activity dashboard:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect my GitHub" to link your account' },
    { id: 'opt2', component: 'Text', text: '• Tell me which repos to track: "Watch org/repo1 and org/repo2"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll build a live activity feed with per-developer breakdowns' },
  ],
  { metrics: { commitsToday: '—', prsMerged: '—', reviewsDone: '—', activeDevs: '—' } },
)

// ---------------------------------------------------------------------------
// Standup Summary Generator
// ---------------------------------------------------------------------------
export const STANDUP_GENERATOR_CANVAS = cs(
  'standup_dashboard', 'Standup Summary',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'blockers_card', 'summary_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'date_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🗓️ Standup Summary', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Not yet generated', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_active', 'kpi_prs', 'kpi_commits', 'kpi_blockers'] },
    { id: 'kpi_active', component: 'Metric', label: 'Team Active', value: { path: '/metrics/teamActive' } },
    { id: 'kpi_prs', component: 'Metric', label: 'PRs in Flight', value: { path: '/metrics/prsInFlight' } },
    { id: 'kpi_commits', component: 'Metric', label: 'Commits (24h)', value: { path: '/metrics/commits24h' } },
    { id: 'kpi_blockers', component: 'Metric', label: 'Blockers', value: { path: '/metrics/blockers' } },
    { id: 'blockers_card', component: 'Card', title: '🚧 Blockers', description: 'Items requiring attention', child: 'blockers_placeholder' },
    { id: 'blockers_placeholder', component: 'Text', text: 'Blockers like stale PRs and failing CI will be highlighted here once GitHub is connected.', variant: 'muted' },
    { id: 'summary_card', component: 'Card', title: 'Today\'s Summary', description: 'Auto-generated from GitHub activity', child: 'summary_placeholder' },
    { id: 'summary_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll automatically generate standup summaries each morning. Each team member\'s Done / In Progress / Blockers will be compiled from their actual commits and PRs.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up automatic standups:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect GitHub and Slack" to link both accounts' },
    { id: 'opt2', component: 'Text', text: '• Tell me your team: "Track @alice, @bob, and @carol"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll generate and post standup summaries every morning at 9 AM' },
  ],
  { metrics: { teamActive: '—', prsInFlight: '—', commits24h: '—', blockers: '—' } },
)

// ---------------------------------------------------------------------------
// Slack Mention Monitor
// ---------------------------------------------------------------------------
export const SLACK_MONITOR_CANVAS = cs(
  'mention_dashboard', 'Slack Monitor',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'mentions_card', 'rules_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'status_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '👁️ Slack Monitor', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'No Slack connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_unread', 'kpi_channels', 'kpi_keywords', 'kpi_today'] },
    { id: 'kpi_unread', component: 'Metric', label: 'Unread Mentions', value: { path: '/metrics/unreadMentions' } },
    { id: 'kpi_channels', component: 'Metric', label: 'Channels Watched', value: { path: '/metrics/channelsWatched' } },
    { id: 'kpi_keywords', component: 'Metric', label: 'Keywords Tracked', value: { path: '/metrics/keywordsTracked' } },
    { id: 'kpi_today', component: 'Metric', label: 'Alerts Today', value: { path: '/metrics/alertsToday' } },
    { id: 'mentions_card', component: 'Card', title: 'Recent Mentions', description: 'Latest @mentions and keyword matches', child: 'mentions_placeholder' },
    { id: 'mentions_placeholder', component: 'Text', text: 'Connect Slack and mentions, keyword matches, and watched channel activity will appear here categorized by urgency.', variant: 'muted' },
    { id: 'rules_card', component: 'Card', title: 'Watch Rules', description: 'Configure what to monitor', child: 'rules_placeholder' },
    { id: 'rules_placeholder', component: 'Text', text: 'Watch rules will appear here. You can add keywords, channels, and priority people to monitor. Each rule can be set to Urgent, Normal, or FYI priority.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up Slack monitoring:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect Slack" to link your workspace' },
    { id: 'opt2', component: 'Text', text: '• Configure: "Watch for mentions of \'production\' and \'outage\'"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll check every 10 minutes and alert you on urgent mentions' },
  ],
  { metrics: { unreadMentions: '0', channelsWatched: '0', keywordsTracked: '0', alertsToday: '0' } },
)

// ---------------------------------------------------------------------------
// Git Commit Insights
// ---------------------------------------------------------------------------
export const GIT_INSIGHTS_CANVAS = cs(
  'git_insights_dashboard', 'Engineering Insights',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'team_card', 'pr_aging_card', 'getting_started'], gap: 'lg' },
    { id: 'header', component: 'Row', children: ['title', 'period_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: '🔍 Engineering Insights', variant: 'h2' },
    { id: 'period_badge', component: 'Badge', text: 'No repos connected', variant: 'outline' },
    { id: 'kpis', component: 'Grid', columns: 4, children: ['kpi_commits', 'kpi_cycle', 'kpi_top', 'kpi_prs'] },
    { id: 'kpi_commits', component: 'Metric', label: 'Weekly Commits', value: { path: '/metrics/weeklyCommits' } },
    { id: 'kpi_cycle', component: 'Metric', label: 'Avg PR Cycle', value: { path: '/metrics/avgCycleTime' } },
    { id: 'kpi_top', component: 'Metric', label: 'Top Reviewer', value: { path: '/metrics/topReviewer' } },
    { id: 'kpi_prs', component: 'Metric', label: 'Active PRs', value: { path: '/metrics/activePrs' } },
    { id: 'team_card', component: 'Card', title: 'Team Leaderboard', description: 'Weekly contribution metrics', child: 'team_placeholder' },
    { id: 'team_placeholder', component: 'Text', text: 'Connect GitHub and I\'ll show a team leaderboard with commits, PRs merged, and reviews given per developer.', variant: 'muted' },
    { id: 'pr_aging_card', component: 'Card', title: 'PR Aging', description: 'Open PRs sorted by age', child: 'pr_aging_placeholder' },
    { id: 'pr_aging_placeholder', component: 'Text', text: 'Open PRs older than 3 days without review will be flagged here. Connect GitHub to start tracking.', variant: 'muted' },
    { id: 'getting_started', component: 'Card', title: '🚀 Getting Started', child: 'gs_col' },
    { id: 'gs_col', component: 'Column', children: ['gs_text', 'gs_options'], gap: 'md' },
    { id: 'gs_text', component: 'Text', text: 'Set up engineering insights:', variant: 'muted' },
    { id: 'gs_options', component: 'Column', children: ['opt1', 'opt2', 'opt3'], gap: 'sm' },
    { id: 'opt1', component: 'Text', text: '• Say "Connect GitHub" to link your account' },
    { id: 'opt2', component: 'Text', text: '• Tell me your repos and team: "Track myorg/api and myorg/web"' },
    { id: 'opt3', component: 'Text', text: '• I\'ll compute PR cycle times, code churn, and team velocity weekly' },
  ],
  { metrics: { weeklyCommits: '—', avgCycleTime: '—', topReviewer: '—', activePrs: '—' } },
)

// ---------------------------------------------------------------------------
// Lookup map
// ---------------------------------------------------------------------------
export const TEMPLATE_CANVAS_STATES: Record<string, TemplateCanvasState> = {
  'research-assistant': RESEARCH_ASSISTANT_CANVAS,
  'github-ops': GITHUB_OPS_CANVAS,
  'support-desk': SUPPORT_DESK_CANVAS,
  'meeting-prep': MEETING_PREP_CANVAS,
  'revenue-tracker': REVENUE_TRACKER_CANVAS,
  'project-board': PROJECT_BOARD_CANVAS,
  'incident-commander': INCIDENT_COMMANDER_CANVAS,
  'personal-assistant': PERSONAL_ASSISTANT_CANVAS,
  'sales-pipeline': SALES_PIPELINE_CANVAS,
  'social-media-manager': SOCIAL_MEDIA_MANAGER_CANVAS,
  'release-manager': RELEASE_MANAGER_CANVAS,
  'hiring-pipeline': HIRING_PIPELINE_CANVAS,
  'newsletter-curator': NEWSLETTER_CURATOR_CANVAS,
  'competitor-intel': COMPETITOR_INTEL_CANVAS,
  'api-health-monitor': API_HEALTH_MONITOR_CANVAS,
  'expense-manager': EXPENSE_MANAGER_CANVAS,
  'fitness-coach': FITNESS_COACH_CANVAS,
  'daily-journal': DAILY_JOURNAL_CANVAS,
  'market-watch': MARKET_WATCH_CANVAS,
  'code-review-assistant': CODE_REVIEW_ASSISTANT_CANVAS,
  'client-onboarding': CLIENT_ONBOARDING_CANVAS,
  'travel-planner': TRAVEL_PLANNER_CANVAS,
  'email-slack-alert': EMAIL_SLACK_ALERT_CANVAS,
  'dev-activity': DEV_ACTIVITY_CANVAS,
  'standup-generator': STANDUP_GENERATOR_CANVAS,
  'slack-monitor': SLACK_MONITOR_CANVAS,
  'git-insights': GIT_INSIGHTS_CANVAS,
  'email-slack-alert': EMAIL_SLACK_ALERT_CANVAS,
  'dev-activity': DEV_ACTIVITY_CANVAS,
  'standup-generator': STANDUP_GENERATOR_CANVAS,
  'slack-monitor': SLACK_MONITOR_CANVAS,
  'git-insights': GIT_INSIGHTS_CANVAS,
}
