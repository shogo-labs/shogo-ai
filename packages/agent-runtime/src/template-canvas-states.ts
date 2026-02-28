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
}
