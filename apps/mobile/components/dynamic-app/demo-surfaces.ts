/**
 * Demo Surfaces
 *
 * Pre-built sample surfaces for previewing the Dynamic App renderer
 * without needing a running agent runtime.
 */

import type { SurfaceState, ComponentDefinition } from './types'

function buildSurface(
  surfaceId: string,
  title: string,
  components: ComponentDefinition[],
  dataModel: Record<string, unknown> = {},
): SurfaceState {
  const compMap = new Map<string, ComponentDefinition>()
  for (const c of components) compMap.set(c.id, c)
  const now = new Date().toISOString()
  return { surfaceId, title, components: compMap, dataModel, createdAt: now, updatedAt: now }
}

// ---------------------------------------------------------------------------
// Flight Search
// ---------------------------------------------------------------------------

export const FLIGHT_SEARCH_SURFACE = buildSurface(
  'demo_flights',
  'Flight Search Results',
  [
    { id: 'root', component: 'Column', children: ['header', 'results'], gap: 'lg' },
    {
      id: 'header', component: 'Row',
      children: ['route_title', 'date_badge'],
      align: 'center', justify: 'between',
    },
    { id: 'route_title', component: 'Text', text: 'SFO → JFK', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: { path: '/search/date' }, variant: 'outline' },
    { id: 'results', component: 'Column', children: ['f1', 'f2', 'f3'], gap: 'md' },
    // Flight 1
    {
      id: 'f1', component: 'Card', title: { path: '/flights/0/airline' },
      description: { path: '/flights/0/times' }, children: ['f1_body'],
    },
    {
      id: 'f1_body', component: 'Row',
      children: ['f1_price', 'f1_stops', 'f1_duration', 'f1_book'],
      align: 'center', justify: 'between',
    },
    { id: 'f1_price', component: 'Text', text: { path: '/flights/0/price' }, variant: 'large' },
    { id: 'f1_stops', component: 'Badge', text: { path: '/flights/0/stops' }, variant: 'secondary' },
    { id: 'f1_duration', component: 'Text', text: { path: '/flights/0/duration' }, variant: 'muted' },
    {
      id: 'f1_book', component: 'Button', label: 'Select Flight', variant: 'default',
      action: { name: 'book_flight', context: { flightId: { path: '/flights/0/id' } } },
    },
    // Flight 2
    {
      id: 'f2', component: 'Card', title: { path: '/flights/1/airline' },
      description: { path: '/flights/1/times' }, children: ['f2_body'],
    },
    {
      id: 'f2_body', component: 'Row',
      children: ['f2_price', 'f2_stops', 'f2_duration', 'f2_book'],
      align: 'center', justify: 'between',
    },
    { id: 'f2_price', component: 'Text', text: { path: '/flights/1/price' }, variant: 'large' },
    { id: 'f2_stops', component: 'Badge', text: { path: '/flights/1/stops' }, variant: 'secondary' },
    { id: 'f2_duration', component: 'Text', text: { path: '/flights/1/duration' }, variant: 'muted' },
    {
      id: 'f2_book', component: 'Button', label: 'Select Flight', variant: 'outline',
      action: { name: 'book_flight', context: { flightId: { path: '/flights/1/id' } } },
    },
    // Flight 3
    {
      id: 'f3', component: 'Card', title: { path: '/flights/2/airline' },
      description: { path: '/flights/2/times' }, children: ['f3_body'],
    },
    {
      id: 'f3_body', component: 'Row',
      children: ['f3_price', 'f3_stops', 'f3_duration', 'f3_book'],
      align: 'center', justify: 'between',
    },
    { id: 'f3_price', component: 'Text', text: { path: '/flights/2/price' }, variant: 'large' },
    { id: 'f3_stops', component: 'Badge', text: { path: '/flights/2/stops' }, variant: 'default' },
    { id: 'f3_duration', component: 'Text', text: { path: '/flights/2/duration' }, variant: 'muted' },
    {
      id: 'f3_book', component: 'Button', label: 'Select Flight', variant: 'outline',
      action: { name: 'book_flight', context: { flightId: { path: '/flights/2/id' } } },
    },
  ],
  {
    search: { date: 'Mar 15, 2026', from: 'SFO', to: 'JFK' },
    flights: [
      { id: 'UA456', airline: 'United Airlines', times: '6:00 AM – 2:30 PM', price: '$299', duration: '5h 30m', stops: 'Nonstop' },
      { id: 'DL789', airline: 'Delta Air Lines', times: '9:15 AM – 5:45 PM', price: '$349', duration: '5h 30m', stops: 'Nonstop' },
      { id: 'AA102', airline: 'American Airlines', times: '12:00 PM – 9:15 PM', price: '$275', duration: '6h 15m', stops: '1 stop' },
    ],
  },
)

// ---------------------------------------------------------------------------
// Email Dashboard
// ---------------------------------------------------------------------------

export const EMAIL_DASHBOARD_SURFACE = buildSurface(
  'demo_email',
  'Email Dashboard',
  [
    { id: 'root', component: 'Column', children: ['header', 'metrics_row', 'sep', 'email_table_section'], gap: 'lg' },
    {
      id: 'header', component: 'Row', children: ['email_title', 'inbox_badge'],
      align: 'center', justify: 'between',
    },
    { id: 'email_title', component: 'Text', text: 'Email Dashboard', variant: 'h2' },
    { id: 'inbox_badge', component: 'Badge', text: 'Inbox', variant: 'outline' },
    {
      id: 'metrics_row', component: 'Grid', columns: 4, gap: 'md',
      children: ['m_total', 'm_unread', 'm_flagged', 'm_drafts'],
    },
    { id: 'm_total', component: 'Metric', label: 'Total', value: { path: '/stats/total' }, description: 'Last 24 hours' },
    { id: 'm_unread', component: 'Metric', label: 'Unread', value: { path: '/stats/unread' }, trendValue: '+12' },
    { id: 'm_flagged', component: 'Metric', label: 'Flagged', value: { path: '/stats/flagged' } },
    { id: 'm_drafts', component: 'Metric', label: 'Drafts', value: { path: '/stats/drafts' } },
    { id: 'sep', component: 'Separator' },
    {
      id: 'email_table_section', component: 'Card', title: 'Important Emails',
      description: 'Emails requiring your attention', children: ['email_table'],
    },
    {
      id: 'email_table', component: 'Table', striped: true,
      columns: [
        { key: 'from', label: 'From', width: '20%' },
        { key: 'subject', label: 'Subject' },
        { key: 'time', label: 'Time', width: '12%', align: 'right' },
      ],
      rows: { path: '/emails' },
    },
  ],
  {
    stats: { total: 47, unread: 12, flagged: 3, drafts: 2 },
    emails: [
      { from: 'CEO', subject: 'Q4 Board Deck — review needed by EOD', time: '9:30 AM' },
      { from: 'Finance', subject: 'Budget approval for Project Atlas', time: '8:15 AM' },
      { from: 'Engineering', subject: 'Prod incident P1 — resolved, postmortem attached', time: '7:42 AM' },
      { from: 'HR', subject: 'New hire onboarding checklist', time: '7:00 AM' },
      { from: 'Product', subject: 'Roadmap update: Q1 priorities', time: 'Yesterday' },
    ],
  },
)

// ---------------------------------------------------------------------------
// Analytics Dashboard
// ---------------------------------------------------------------------------

export const ANALYTICS_SURFACE = buildSurface(
  'demo_analytics',
  'Sales Analytics',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'charts_row', 'top_products'], gap: 'lg' },
    {
      id: 'header', component: 'Row', children: ['title', 'period'],
      align: 'center', justify: 'between',
    },
    { id: 'title', component: 'Text', text: 'Sales Analytics', variant: 'h2' },
    { id: 'period', component: 'Badge', text: 'Q4 2025', variant: 'outline' },
    {
      id: 'kpis', component: 'Grid', columns: 3, gap: 'md',
      children: ['kpi_rev', 'kpi_orders', 'kpi_aov'],
    },
    { id: 'kpi_rev', component: 'Metric', label: 'Revenue', value: '$2.4M', trendValue: '+18%' },
    { id: 'kpi_orders', component: 'Metric', label: 'Orders', value: '18,200', trendValue: '+7%' },
    { id: 'kpi_aov', component: 'Metric', label: 'Avg Order Value', value: '$132', trendValue: '-3%' },
    {
      id: 'charts_row', component: 'Grid', columns: 2, gap: 'md',
      children: ['rev_card', 'cat_card'],
    },
    { id: 'rev_card', component: 'Card', title: 'Monthly Revenue', children: ['rev_chart'] },
    {
      id: 'rev_chart', component: 'Chart', type: 'bar', height: 200,
      data: [
        { label: 'Jul', value: 380000 },
        { label: 'Aug', value: 420000 },
        { label: 'Sep', value: 510000 },
        { label: 'Oct', value: 580000 },
        { label: 'Nov', value: 720000 },
        { label: 'Dec', value: 1100000 },
      ],
    },
    { id: 'cat_card', component: 'Card', title: 'Sales by Category', children: ['cat_chart'] },
    {
      id: 'cat_chart', component: 'Chart', type: 'horizontalBar',
      data: [
        { label: 'Electronics', value: 890000, color: '#3b82f6' },
        { label: 'Apparel', value: 620000, color: '#8b5cf6' },
        { label: 'Home', value: 480000, color: '#10b981' },
        { label: 'Sports', value: 310000, color: '#f59e0b' },
      ],
    },
    { id: 'top_products', component: 'Card', title: 'Top Products', children: ['prod_table'] },
    {
      id: 'prod_table', component: 'Table', striped: true,
      columns: [
        { key: 'name', label: 'Product' },
        { key: 'units', label: 'Units Sold', align: 'right' },
        { key: 'revenue', label: 'Revenue', align: 'right' },
        { key: 'growth', label: 'Growth', align: 'right' },
      ],
      rows: [
        { name: 'Widget Pro', units: '4,200', revenue: '$554K', growth: '+23%' },
        { name: 'GadgetX', units: '3,100', revenue: '$410K', growth: '+15%' },
        { name: 'DataSync', units: '2,800', revenue: '$370K', growth: '+8%' },
        { name: 'CloudPack', units: '2,100', revenue: '$278K', growth: '+31%' },
      ],
    },
  ],
)

// ---------------------------------------------------------------------------
// Meeting Scheduler
// ---------------------------------------------------------------------------

export const SCHEDULER_SURFACE = buildSurface(
  'demo_scheduler',
  'Schedule Meeting',
  [
    {
      id: 'root', component: 'Card', title: 'Schedule a Meeting',
      description: 'Pick a time slot that works for everyone', children: ['form'],
    },
    { id: 'form', component: 'Column', children: ['title_field', 'date_select', 'time_picker', 'sep', 'actions'], gap: 'md' },
    { id: 'title_field', component: 'TextField', label: 'Meeting Title', placeholder: 'e.g. Sprint Planning' },
    {
      id: 'date_select', component: 'Select', label: 'Date', placeholder: 'Select a date',
      options: [
        { label: 'Monday, Mar 16', value: '2026-03-16' },
        { label: 'Tuesday, Mar 17', value: '2026-03-17' },
        { label: 'Wednesday, Mar 18', value: '2026-03-18' },
        { label: 'Thursday, Mar 19', value: '2026-03-19' },
      ],
    },
    {
      id: 'time_picker', component: 'ChoicePicker', label: 'Available Slots',
      options: [
        { label: '9:00 AM', value: '09:00' },
        { label: '10:30 AM', value: '10:30' },
        { label: '2:00 PM', value: '14:00' },
        { label: '3:30 PM', value: '15:30' },
      ],
    },
    { id: 'sep', component: 'Separator' },
    { id: 'actions', component: 'Row', children: ['cancel_btn', 'submit_btn'], justify: 'end', gap: 'sm' },
    { id: 'cancel_btn', component: 'Button', label: 'Cancel', variant: 'outline', action: { name: 'cancel' } },
    {
      id: 'submit_btn', component: 'Button', label: 'Schedule Meeting', variant: 'default',
      action: { name: 'schedule' },
    },
  ],
)

// ---------------------------------------------------------------------------
// Project Overview
// ---------------------------------------------------------------------------

export const PROJECT_OVERVIEW_SURFACE = buildSurface(
  'demo_project',
  'Project Overview',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'main_grid', 'team_section'], gap: 'lg' },

    // Header
    {
      id: 'header', component: 'Row', children: ['title_col', 'header_actions'],
      align: 'center', justify: 'between',
    },
    {
      id: 'title_col', component: 'Column', children: ['proj_title', 'proj_desc'], gap: 'xs',
    },
    { id: 'proj_title', component: 'Text', text: 'Project Atlas', variant: 'h2' },
    { id: 'proj_desc', component: 'Text', text: 'Enterprise data platform — Sprint 14', variant: 'muted' },
    {
      id: 'header_actions', component: 'Row', children: ['status_badge', 'edit_btn'], gap: 'sm', align: 'center',
    },
    { id: 'status_badge', component: 'Badge', text: 'In Progress', variant: 'default' },
    { id: 'edit_btn', component: 'Button', label: 'Settings', variant: 'outline', size: 'sm', action: { name: 'settings' } },

    // KPIs
    {
      id: 'kpis', component: 'Grid', columns: 4, gap: 'md',
      children: ['kpi_tasks', 'kpi_velocity', 'kpi_bugs', 'kpi_coverage'],
    },
    { id: 'kpi_tasks', component: 'Metric', label: 'Open Tasks', value: '24', trendValue: '-6 this week' },
    { id: 'kpi_velocity', component: 'Metric', label: 'Velocity', value: '47', unit: 'pts', trendValue: '+12%' },
    { id: 'kpi_bugs', component: 'Metric', label: 'Open Bugs', value: '8', trendValue: '-3' },
    { id: 'kpi_coverage', component: 'Metric', label: 'Test Coverage', value: '87%', trendValue: '+2.4%' },

    // Main grid
    {
      id: 'main_grid', component: 'Grid', columns: 2, gap: 'md',
      children: ['sprint_card', 'right_stack'],
    },

    // Sprint board
    {
      id: 'sprint_card', component: 'Card', title: 'Sprint Board',
      description: 'Current sprint tasks by status', children: ['sprint_cols'],
    },
    {
      id: 'sprint_cols', component: 'Grid', columns: 3, gap: 'sm',
      children: ['col_todo', 'col_progress', 'col_done'],
    },
    {
      id: 'col_todo', component: 'Column', children: ['col_todo_header', 'task_1', 'task_2', 'task_3'], gap: 'sm',
    },
    {
      id: 'col_todo_header', component: 'Row', children: ['col_todo_label', 'col_todo_count'], align: 'center', justify: 'between',
    },
    { id: 'col_todo_label', component: 'Text', text: 'To Do', variant: 'h6' },
    { id: 'col_todo_count', component: 'Badge', text: '3', variant: 'secondary' },
    {
      id: 'task_1', component: 'Card', title: 'Auth token refresh',
      description: 'Implement silent refresh flow', children: ['task_1_meta'],
    },
    {
      id: 'task_1_meta', component: 'Row', children: ['task_1_priority', 'task_1_points'], align: 'center', justify: 'between',
    },
    { id: 'task_1_priority', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'task_1_points', component: 'Text', text: '5 pts', variant: 'caption' },
    {
      id: 'task_2', component: 'Card', title: 'Dashboard filters',
      description: 'Add date range & status filters', children: ['task_2_meta'],
    },
    {
      id: 'task_2_meta', component: 'Row', children: ['task_2_priority', 'task_2_points'], align: 'center', justify: 'between',
    },
    { id: 'task_2_priority', component: 'Badge', text: 'Medium', variant: 'outline' },
    { id: 'task_2_points', component: 'Text', text: '3 pts', variant: 'caption' },
    {
      id: 'task_3', component: 'Card', title: 'API rate limiting',
      description: 'Redis-backed sliding window', children: ['task_3_meta'],
    },
    {
      id: 'task_3_meta', component: 'Row', children: ['task_3_priority', 'task_3_points'], align: 'center', justify: 'between',
    },
    { id: 'task_3_priority', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'task_3_points', component: 'Text', text: '8 pts', variant: 'caption' },
    // In Progress column
    {
      id: 'col_progress', component: 'Column', children: ['col_prog_header', 'task_4', 'task_5'], gap: 'sm',
    },
    {
      id: 'col_prog_header', component: 'Row', children: ['col_prog_label', 'col_prog_count'], align: 'center', justify: 'between',
    },
    { id: 'col_prog_label', component: 'Text', text: 'In Progress', variant: 'h6' },
    { id: 'col_prog_count', component: 'Badge', text: '2', variant: 'secondary' },
    {
      id: 'task_4', component: 'Card', title: 'User settings page',
      description: 'Profile, notifications, billing', children: ['task_4_meta'],
    },
    {
      id: 'task_4_meta', component: 'Row', children: ['task_4_priority', 'task_4_assign'], align: 'center', justify: 'between',
    },
    { id: 'task_4_priority', component: 'Badge', text: 'Medium', variant: 'outline' },
    { id: 'task_4_assign', component: 'Text', text: '@sarah', variant: 'caption' },
    {
      id: 'task_5', component: 'Card', title: 'WebSocket events',
      description: 'Real-time notification feed', children: ['task_5_meta'],
    },
    {
      id: 'task_5_meta', component: 'Row', children: ['task_5_priority', 'task_5_assign'], align: 'center', justify: 'between',
    },
    { id: 'task_5_priority', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'task_5_assign', component: 'Text', text: '@mike', variant: 'caption' },
    // Done column
    {
      id: 'col_done', component: 'Column', children: ['col_done_header', 'task_6', 'task_7'], gap: 'sm',
    },
    {
      id: 'col_done_header', component: 'Row', children: ['col_done_label', 'col_done_count'], align: 'center', justify: 'between',
    },
    { id: 'col_done_label', component: 'Text', text: 'Done', variant: 'h6' },
    { id: 'col_done_count', component: 'Badge', text: '2', variant: 'secondary' },
    {
      id: 'task_6', component: 'Card', title: 'CI pipeline v2',
      description: 'Parallel test runners', children: ['task_6_meta'],
    },
    {
      id: 'task_6_meta', component: 'Row', children: ['task_6_check', 'task_6_points'], align: 'center', justify: 'between',
    },
    { id: 'task_6_check', component: 'Icon', name: 'check-circle', size: 'sm', color: 'emerald-500' },
    { id: 'task_6_points', component: 'Text', text: '5 pts', variant: 'caption' },
    {
      id: 'task_7', component: 'Card', title: 'DB migration tool',
      description: 'Automated schema diffs', children: ['task_7_meta'],
    },
    {
      id: 'task_7_meta', component: 'Row', children: ['task_7_check', 'task_7_points'], align: 'center', justify: 'between',
    },
    { id: 'task_7_check', component: 'Icon', name: 'check-circle', size: 'sm', color: 'emerald-500' },
    { id: 'task_7_points', component: 'Text', text: '3 pts', variant: 'caption' },

    // Right stack
    {
      id: 'right_stack', component: 'Column', children: ['burndown_card', 'activity_card'], gap: 'md',
    },
    {
      id: 'burndown_card', component: 'Card', title: 'Sprint Burndown', children: ['burndown_chart'],
    },
    {
      id: 'burndown_chart', component: 'Chart', type: 'bar', height: 160,
      data: [
        { label: 'Mon', value: 47 },
        { label: 'Tue', value: 42 },
        { label: 'Wed', value: 38 },
        { label: 'Thu', value: 31 },
        { label: 'Fri', value: 24 },
      ],
    },
    {
      id: 'activity_card', component: 'Card', title: 'Recent Activity',
      description: 'Last 24 hours', children: ['activity_table'],
    },
    {
      id: 'activity_table', component: 'Table', compact: true,
      columns: [
        { key: 'who', label: 'Who', width: '25%' },
        { key: 'action', label: 'Action' },
        { key: 'time', label: 'When', width: '20%', align: 'right' },
      ],
      rows: [
        { who: 'Sarah', action: 'Completed "User settings page"', time: '2h ago' },
        { who: 'Mike', action: 'Pushed 3 commits to ws-events', time: '3h ago' },
        { who: 'Alex', action: 'Opened PR #142 — Auth refresh', time: '5h ago' },
        { who: 'Priya', action: 'Filed bug: Memory leak in SSE', time: '6h ago' },
        { who: 'Jordan', action: 'Merged PR #139 — CI pipeline', time: '8h ago' },
      ],
    },

    // Team section
    {
      id: 'team_section', component: 'Card', title: 'Team Performance',
      description: 'Individual contributor stats this sprint', children: ['team_grid'],
    },
    {
      id: 'team_grid', component: 'Grid', columns: 3, gap: 'md',
      children: ['member_1', 'member_2', 'member_3'],
    },
    {
      id: 'member_1', component: 'Card', title: 'Sarah Chen', description: 'Frontend Lead',
      children: ['m1_stats'],
    },
    {
      id: 'm1_stats', component: 'Column', children: ['m1_row1', 'm1_progress'], gap: 'sm',
    },
    {
      id: 'm1_row1', component: 'Row', children: ['m1_tasks', 'm1_pts'], justify: 'between',
    },
    { id: 'm1_tasks', component: 'Text', text: '8 tasks completed', variant: 'body' },
    { id: 'm1_pts', component: 'Badge', text: '21 pts', variant: 'secondary' },
    { id: 'm1_progress', component: 'Progress', value: 85, max: 100 },

    {
      id: 'member_2', component: 'Card', title: 'Mike Torres', description: 'Backend Engineer',
      children: ['m2_stats'],
    },
    {
      id: 'm2_stats', component: 'Column', children: ['m2_row1', 'm2_progress'], gap: 'sm',
    },
    {
      id: 'm2_row1', component: 'Row', children: ['m2_tasks', 'm2_pts'], justify: 'between',
    },
    { id: 'm2_tasks', component: 'Text', text: '6 tasks completed', variant: 'body' },
    { id: 'm2_pts', component: 'Badge', text: '18 pts', variant: 'secondary' },
    { id: 'm2_progress', component: 'Progress', value: 72, max: 100 },

    {
      id: 'member_3', component: 'Card', title: 'Alex Kim', description: 'Full Stack',
      children: ['m3_stats'],
    },
    {
      id: 'm3_stats', component: 'Column', children: ['m3_row1', 'm3_progress'], gap: 'sm',
    },
    {
      id: 'm3_row1', component: 'Row', children: ['m3_tasks', 'm3_pts'], justify: 'between',
    },
    { id: 'm3_tasks', component: 'Text', text: '5 tasks completed', variant: 'body' },
    { id: 'm3_pts', component: 'Badge', text: '14 pts', variant: 'secondary' },
    { id: 'm3_progress', component: 'Progress', value: 60, max: 100 },
  ],
)

// ---------------------------------------------------------------------------
// Expense Tracker (CRUD with auto-formatting)
// ---------------------------------------------------------------------------

export const EXPENSE_TRACKER_SURFACE = buildSurface(
  'demo_expenses',
  'Expense Tracker',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'add_card', 'expenses_card'] },
    {
      id: 'header', component: 'Row', children: ['title', 'period'],
      align: 'center', justify: 'between',
    },
    { id: 'title', component: 'Text', text: 'Expense Tracker', variant: 'h2' },
    { id: 'period', component: 'Badge', text: 'February 2026', variant: 'outline' },
    {
      id: 'kpis', component: 'Grid', columns: 3,
      children: ['kpi_spent', 'kpi_budget', 'kpi_remaining'],
    },
    { id: 'kpi_spent', component: 'Metric', label: 'Total Spent', value: 1847, unit: '$', trendValue: '+$312 this week' },
    { id: 'kpi_budget', component: 'Metric', label: 'Monthly Budget', value: 3000, unit: '$', description: 'Your limit' },
    { id: 'kpi_remaining', component: 'Metric', label: 'Remaining', value: 1153, unit: '$', trendValue: '-10.4%' },
    {
      id: 'add_card', component: 'Card', title: 'Add Expense',
      description: 'Record a new expense', child: 'add_form',
    },
    {
      id: 'add_form', component: 'Row',
      children: ['desc_input', 'amt_input', 'cat_select', 'add_btn'],
      gap: 'sm', align: 'end',
    },
    { id: 'desc_input', component: 'TextField', label: 'Description', placeholder: 'Coffee, groceries...' },
    { id: 'amt_input', component: 'TextField', label: 'Amount', placeholder: '0.00', type: 'number' },
    {
      id: 'cat_select', component: 'Select', label: 'Category', placeholder: 'Select...',
      options: [
        { label: 'Food', value: 'food' }, { label: 'Transport', value: 'transport' },
        { label: 'Entertainment', value: 'entertainment' }, { label: 'Utilities', value: 'utilities' },
        { label: 'Shopping', value: 'shopping' },
      ],
    },
    {
      id: 'add_btn', component: 'Button', label: 'Add Expense',
      action: { name: 'add_expense' },
    },
    {
      id: 'expenses_card', component: 'Card', title: 'Recent Expenses',
      description: 'Your spending this month', child: 'expense_table',
    },
    {
      id: 'expense_table', component: 'Table', striped: true,
      columns: [
        { key: 'description', label: 'Description' },
        { key: 'category', label: 'Category' },
        { key: 'date', label: 'Date', align: 'right' },
        { key: 'amount', label: 'Amount', align: 'right' },
      ],
      rows: [
        { description: 'Lunch at Chez Marie', category: 'Food', date: '2026-02-26T12:30:00Z', amount: 42.50 },
        { description: 'Uber to airport', category: 'Transport', date: '2026-02-25T08:15:00Z', amount: 38.00 },
        { description: 'Electric bill', category: 'Utilities', date: '2026-02-24T00:00:00Z', amount: 127.80 },
        { description: 'Netflix subscription', category: 'Entertainment', date: '2026-02-23T00:00:00Z', amount: 15.99 },
        { description: 'Grocery haul', category: 'Food', date: '2026-02-22T16:45:00Z', amount: 94.30 },
        { description: 'Running shoes', category: 'Shopping', date: '2026-02-20T11:00:00Z', amount: 129.00 },
      ],
    },
  ],
)

// ---------------------------------------------------------------------------
// Habit Tracker (Kanban board)
// ---------------------------------------------------------------------------

export const HABIT_TRACKER_SURFACE = buildSurface(
  'demo_habits',
  'Habit Tracker',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'add_card', 'board'] },
    {
      id: 'header', component: 'Row', children: ['title', 'date_badge'],
      align: 'center', justify: 'between',
    },
    { id: 'title', component: 'Text', text: 'Habit Tracker', variant: 'h2' },
    { id: 'date_badge', component: 'Badge', text: 'Week of Feb 23', variant: 'outline' },
    {
      id: 'kpis', component: 'Grid', columns: 3,
      children: ['kpi_total', 'kpi_active', 'kpi_streak'],
    },
    { id: 'kpi_total', component: 'Metric', label: 'Total Habits', value: '8', trendValue: '+2 this month' },
    { id: 'kpi_active', component: 'Metric', label: 'Active Today', value: '5', trendValue: '+1' },
    { id: 'kpi_streak', component: 'Metric', label: 'Best Streak', value: '45 days', description: 'Drink water' },
    {
      id: 'add_card', component: 'Card', title: 'Quick Add',
      description: 'Start tracking a new habit', child: 'add_row',
    },
    {
      id: 'add_row', component: 'Row',
      children: ['habit_input', 'habit_btn'],
      gap: 'sm', align: 'end',
    },
    { id: 'habit_input', component: 'TextField', placeholder: 'e.g. Morning yoga', label: 'Habit Name' },
    { id: 'habit_btn', component: 'Button', label: 'Add', action: { name: 'add_habit' } },
    {
      id: 'board', component: 'Grid', columns: 3, gap: 'md',
      children: ['col_todo', 'col_progress', 'col_done'],
    },
    // Not Started
    {
      id: 'col_todo', component: 'Card', title: 'Not Started',
      description: '3 habits', child: 'todo_list',
    },
    { id: 'todo_list', component: 'Column', children: ['h1', 'h2', 'h3'], gap: 'sm' },
    {
      id: 'h1', component: 'Card', title: 'Learn Spanish',
      description: '30 min practice', children: ['h1_meta'],
    },
    {
      id: 'h1_meta', component: 'Row',
      children: ['h1_priority', 'h1_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h1_priority', component: 'Badge', text: 'Medium', variant: 'outline' },
    { id: 'h1_action', component: 'Button', label: 'Start', size: 'sm', variant: 'outline', action: { name: 'start' } },
    {
      id: 'h2', component: 'Card', title: 'Cold shower',
      description: '5 min cold exposure', children: ['h2_meta'],
    },
    {
      id: 'h2_meta', component: 'Row',
      children: ['h2_priority', 'h2_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h2_priority', component: 'Badge', text: 'Low', variant: 'secondary' },
    { id: 'h2_action', component: 'Button', label: 'Start', size: 'sm', variant: 'outline', action: { name: 'start' } },
    {
      id: 'h3', component: 'Card', title: 'Gratitude journal',
      description: 'Write 3 things', children: ['h3_meta'],
    },
    {
      id: 'h3_meta', component: 'Row',
      children: ['h3_priority', 'h3_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h3_priority', component: 'Badge', text: 'High', variant: 'destructive' },
    { id: 'h3_action', component: 'Button', label: 'Start', size: 'sm', variant: 'outline', action: { name: 'start' } },
    // In Progress
    {
      id: 'col_progress', component: 'Card', title: 'In Progress',
      description: '3 active', child: 'progress_list',
    },
    { id: 'progress_list', component: 'Column', children: ['h4', 'h5', 'h6'], gap: 'sm' },
    {
      id: 'h4', component: 'Card', title: 'Morning exercise',
      description: '30 min workout', children: ['h4_meta'],
    },
    {
      id: 'h4_meta', component: 'Row',
      children: ['h4_streak', 'h4_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h4_streak', component: 'Badge', text: '12 day streak', variant: 'default' },
    { id: 'h4_action', component: 'Button', label: 'Done', size: 'sm', action: { name: 'complete' } },
    {
      id: 'h5', component: 'Card', title: 'Read 30 pages',
      description: 'Daily reading', children: ['h5_meta'],
    },
    {
      id: 'h5_meta', component: 'Row',
      children: ['h5_streak', 'h5_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h5_streak', component: 'Badge', text: '8 day streak', variant: 'default' },
    { id: 'h5_action', component: 'Button', label: 'Done', size: 'sm', action: { name: 'complete' } },
    {
      id: 'h6', component: 'Card', title: 'Meditation',
      description: '10 min session', children: ['h6_meta'],
    },
    {
      id: 'h6_meta', component: 'Row',
      children: ['h6_streak', 'h6_action'],
      align: 'center', justify: 'between',
    },
    { id: 'h6_streak', component: 'Badge', text: '5 day streak', variant: 'default' },
    { id: 'h6_action', component: 'Button', label: 'Done', size: 'sm', action: { name: 'complete' } },
    // Completed
    {
      id: 'col_done', component: 'Card', title: 'Completed',
      description: '2 done today', child: 'done_list',
    },
    { id: 'done_list', component: 'Column', children: ['h7', 'h8'], gap: 'sm' },
    {
      id: 'h7', component: 'Card', title: 'Drink 8 glasses',
      description: 'Stay hydrated', children: ['h7_meta'],
    },
    {
      id: 'h7_meta', component: 'Row',
      children: ['h7_streak', 'h7_icon'],
      align: 'center', justify: 'between',
    },
    { id: 'h7_streak', component: 'Badge', text: '45 day streak', variant: 'default' },
    { id: 'h7_icon', component: 'Icon', name: 'check-circle', size: 'sm', color: 'emerald-500' },
    {
      id: 'h8', component: 'Card', title: 'Walk 20 minutes',
      description: 'After lunch walk', children: ['h8_meta'],
    },
    {
      id: 'h8_meta', component: 'Row',
      children: ['h8_streak', 'h8_icon'],
      align: 'center', justify: 'between',
    },
    { id: 'h8_streak', component: 'Badge', text: '31 day streak', variant: 'default' },
    { id: 'h8_icon', component: 'Icon', name: 'check-circle', size: 'sm', color: 'emerald-500' },
  ],
)

// ---------------------------------------------------------------------------
// Support Tickets
// ---------------------------------------------------------------------------

export const SUPPORT_TICKETS_SURFACE = buildSurface(
  'demo_support',
  'Support Tickets',
  [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'chart_row', 'tickets_card'] },
    {
      id: 'header', component: 'Row', children: ['title', 'status_badge'],
      align: 'center', justify: 'between',
    },
    { id: 'title', component: 'Text', text: 'Support Dashboard', variant: 'h2' },
    { id: 'status_badge', component: 'Badge', text: 'Live', variant: 'default' },
    {
      id: 'kpis', component: 'Grid', columns: 4,
      children: ['kpi_open', 'kpi_resolved', 'kpi_avg', 'kpi_csat'],
    },
    { id: 'kpi_open', component: 'Metric', label: 'Open Tickets', value: 23, trendValue: '+5 today' },
    { id: 'kpi_resolved', component: 'Metric', label: 'Resolved (7d)', value: 142, trendValue: '+18%' },
    { id: 'kpi_avg', component: 'Metric', label: 'Avg Response', value: '2.4h', trendValue: '-15 min' },
    { id: 'kpi_csat', component: 'Metric', label: 'CSAT Score', value: 94, unit: '%', trendValue: '+2.1%' },
    {
      id: 'chart_row', component: 'Grid', columns: 2, gap: 'md',
      children: ['volume_card', 'priority_card'],
    },
    {
      id: 'volume_card', component: 'Card', title: 'Ticket Volume',
      description: 'Last 7 days', children: ['volume_chart'],
    },
    {
      id: 'volume_chart', component: 'Chart', type: 'bar', height: 180,
      data: [
        { label: 'Mon', value: 28 },
        { label: 'Tue', value: 35 },
        { label: 'Wed', value: 42 },
        { label: 'Thu', value: 31 },
        { label: 'Fri', value: 38 },
        { label: 'Sat', value: 12 },
        { label: 'Sun', value: 8 },
      ],
    },
    {
      id: 'priority_card', component: 'Card', title: 'By Priority',
      description: 'Open tickets', children: ['priority_chart'],
    },
    {
      id: 'priority_chart', component: 'Chart', type: 'horizontalBar',
      data: [
        { label: 'Critical', value: 3, color: '#ef4444' },
        { label: 'High', value: 7, color: '#f97316' },
        { label: 'Medium', value: 9, color: '#eab308' },
        { label: 'Low', value: 4, color: '#22c55e' },
      ],
    },
    {
      id: 'tickets_card', component: 'Card', title: 'Recent Tickets',
      description: 'Requires attention', child: 'tickets_table',
    },
    {
      id: 'tickets_table', component: 'Table', striped: true,
      columns: [
        { key: 'id', label: '#', width: '8%' },
        { key: 'subject', label: 'Subject' },
        { key: 'priority', label: 'Priority', width: '12%' },
        { key: 'status', label: 'Status', width: '12%' },
        { key: 'created', label: 'Created', align: 'right', width: '15%' },
      ],
      rows: [
        { id: 'T-1024', subject: 'Cannot access billing portal', priority: 'Critical', status: 'Open', created: '2026-02-26T09:15:00Z' },
        { id: 'T-1023', subject: 'API rate limit exceeded during peak', priority: 'High', status: 'In Progress', created: '2026-02-26T08:30:00Z' },
        { id: 'T-1022', subject: 'PDF export shows wrong currency', priority: 'Medium', status: 'Open', created: '2026-02-25T16:45:00Z' },
        { id: 'T-1021', subject: 'SSO login fails for new domain', priority: 'High', status: 'In Progress', created: '2026-02-25T14:20:00Z' },
        { id: 'T-1020', subject: 'Dark mode colors inconsistent', priority: 'Low', status: 'Open', created: '2026-02-25T11:00:00Z' },
        { id: 'T-1019', subject: 'Webhook delivery delays', priority: 'Medium', status: 'Resolved', created: '2026-02-24T22:10:00Z' },
      ],
    },
  ],
)

// ---------------------------------------------------------------------------
// Drive Time to LAX — Imported from staging project 78f280c9
// Multi-tab dashboard: drive time + weather + restaurants with DataList
// ---------------------------------------------------------------------------

export const DRIVE_TIME_LAX_SURFACE = buildSurface(
  'drive_time_lax',
  'Drive Time to LAX',
  [
    { id: 'root', component: 'Column', children: ['header_row', 'main_tabs'] },
    { id: 'header_row', component: 'Row', children: ['title', 'time_badge'], align: 'center', justify: 'between' },
    { id: 'title', component: 'Text', text: 'Drive to LAX', variant: 'h2' },
    { id: 'time_badge', component: 'Badge', text: { path: '/currentTime' }, variant: 'outline' },
    { id: 'main_tabs', component: 'Tabs', children: ['drive_panel', 'restaurants_panel'] },

    // Drive tab
    { id: 'drive_panel', component: 'TabPanel', title: 'Drive to LAX', children: ['weather_card', 'metrics_grid', 'details_card', 'traffic_alert'] },
    { id: 'metrics_grid', component: 'Grid', columns: 3, children: ['metric_time', 'metric_distance', 'metric_delay'] },
    { id: 'metric_time', component: 'Metric', label: 'Current Drive Time', value: { path: '/durationWithTraffic' }, description: 'With live traffic', trendValue: { path: '/trafficDelay' } },
    { id: 'metric_distance', component: 'Metric', label: 'Distance', value: { path: '/distance' }, description: 'Via US-101 South' },
    { id: 'metric_delay', component: 'Metric', label: 'No-Traffic Time', value: { path: '/durationNoTraffic' }, description: 'Baseline duration' },
    { id: 'details_card', component: 'Card', title: 'Route Details', description: 'Your journey information', child: 'details_content' },
    { id: 'details_content', component: 'Column', children: ['origin_row', 'dest_row', 'route_row'], gap: 'md' },
    { id: 'origin_row', component: 'Row', children: ['origin_label', 'origin_value'], align: 'center', gap: 'sm' },
    { id: 'origin_label', component: 'Text', text: 'From:', weight: 'medium' },
    { id: 'origin_value', component: 'Text', text: { path: '/origin' } },
    { id: 'dest_row', component: 'Row', children: ['dest_label', 'dest_value'], align: 'center', gap: 'sm' },
    { id: 'dest_label', component: 'Text', text: 'To:', weight: 'medium' },
    { id: 'dest_value', component: 'Text', text: { path: '/destination' } },
    { id: 'route_row', component: 'Row', children: ['route_label', 'route_value'], align: 'center', gap: 'sm' },
    { id: 'route_label', component: 'Text', text: 'Best Route:', weight: 'medium' },
    { id: 'route_value', component: 'Badge', text: { path: '/route' }, variant: 'secondary' },
    { id: 'traffic_alert', component: 'Alert', title: 'Traffic Notice', description: 'Current traffic is adding 37 minutes to your journey. Consider leaving earlier if you have a tight schedule.', variant: 'default' },

    // Weather card
    { id: 'weather_card', component: 'Card', title: 'Current Weather', description: 'Conditions at your location', child: 'weather_content' },
    { id: 'weather_content', component: 'Row', children: ['weather_left', 'weather_right'], justify: 'between', align: 'center' },
    { id: 'weather_left', component: 'Column', children: ['temp_row', 'condition_text'], gap: 'xs' },
    { id: 'temp_row', component: 'Row', children: ['temp_value', 'temp_unit'], align: 'baseline', gap: 'xs' },
    { id: 'temp_value', component: 'Text', text: { path: '/weather/temperature' }, variant: 'h1' },
    { id: 'temp_unit', component: 'Text', text: { path: '/weather/temperatureUnit' }, variant: 'h3' },
    { id: 'condition_text', component: 'Badge', text: { path: '/weather/condition' }, variant: 'secondary' },
    { id: 'weather_right', component: 'Grid', columns: 2, children: ['humidity_metric', 'wind_metric'], gap: 'sm' },
    { id: 'humidity_metric', component: 'Column', children: ['humidity_label', 'humidity_value'], gap: 'xs' },
    { id: 'humidity_label', component: 'Text', text: 'Humidity', variant: 'caption' },
    { id: 'humidity_value', component: 'Text', text: { path: '/weather/humidity' }, weight: 'medium' },
    { id: 'wind_metric', component: 'Column', children: ['wind_label', 'wind_value'], gap: 'xs' },
    { id: 'wind_label', component: 'Text', text: 'Wind', variant: 'caption' },
    { id: 'wind_value', component: 'Text', text: { path: '/weather/windSpeed' }, weight: 'medium' },

    // Restaurants tab
    { id: 'restaurants_panel', component: 'TabPanel', title: 'Lunch Spots', children: ['restaurants_header', 'restaurants_list'] },
    { id: 'restaurants_header', component: 'Card', title: 'Favorite Restaurants', description: 'Lunch availability at your go-to spots (1-2 PM)', child: 'preferred_times' },
    { id: 'preferred_times', component: 'Row', children: ['time_badge_1', 'time_badge_2'], gap: 'sm' },
    { id: 'time_badge_1', component: 'Badge', text: '1:00 PM', variant: 'secondary' },
    { id: 'time_badge_2', component: 'Badge', text: '2:00 PM', variant: 'secondary' },
    { id: 'restaurants_list', component: 'DataList', children: { path: '/restaurants/favorites', templateId: 'restaurant_card' }, emptyText: 'No restaurants saved yet' },
    { id: 'restaurant_card', component: 'Card', child: 'restaurant_content' },
    { id: 'restaurant_content', component: 'Column', children: ['restaurant_header', 'restaurant_details', 'restaurant_actions'], gap: 'md' },
    { id: 'restaurant_header', component: 'Row', children: ['restaurant_name', 'restaurant_rating'], justify: 'between', align: 'center' },
    { id: 'restaurant_name', component: 'Text', text: { path: 'name' }, variant: 'h4', weight: 'bold' },
    { id: 'restaurant_rating', component: 'Badge', text: { path: 'rating' }, variant: 'default' },
    { id: 'restaurant_details', component: 'Column', children: ['restaurant_type_row', 'restaurant_location_row', 'restaurant_contact_row'], gap: 'sm' },
    { id: 'restaurant_type_row', component: 'Row', children: ['restaurant_type', 'restaurant_price'], gap: 'sm' },
    { id: 'restaurant_type', component: 'Badge', text: { path: 'type' }, variant: 'secondary' },
    { id: 'restaurant_price', component: 'Badge', text: { path: 'price' }, variant: 'outline' },
    { id: 'restaurant_location_row', component: 'Row', children: ['restaurant_address'], gap: 'xs', align: 'center' },
    { id: 'restaurant_address', component: 'Text', text: { path: 'address' }, variant: 'body' },
    { id: 'restaurant_contact_row', component: 'Row', children: ['restaurant_phone'], gap: 'xs', align: 'center' },
    { id: 'restaurant_phone', component: 'Text', text: { path: 'phone' }, variant: 'body' },
    { id: 'restaurant_actions', component: 'Row', children: ['view_yelp_btn', 'check_availability_info'], gap: 'sm', justify: 'between', align: 'center' },
    { id: 'view_yelp_btn', component: 'Button', label: 'View on Yelp', variant: 'outline', size: 'sm' },
    { id: 'check_availability_info', component: 'Text', text: 'Check availability by calling or visiting Yelp', variant: 'caption' },
  ] as ComponentDefinition[],
  {
    origin: '2220 Bella Vista Drive, Montecito, CA',
    destination: 'Los Angeles International Airport (LAX)',
    currentTime: 'Friday, February 27, 2026 - 8:22 PM',
    distance: '97.1 miles',
    distanceMeters: 156277,
    durationWithTraffic: '2 hours 16 minutes',
    durationWithTrafficSeconds: 8183,
    durationNoTraffic: '1 hour 39 minutes',
    durationNoTrafficSeconds: 5956,
    trafficDelay: '+37 minutes',
    trafficDelaySeconds: 2227,
    route: 'US-101 South (Optimal with Traffic)',
    weather: {
      location: 'Montecito, California',
      condition: 'Clear sky',
      temperature: 82,
      temperatureUnit: '\u00B0F',
      feelsLike: 82,
      humidity: 40,
      windSpeed: 5.7,
      windSpeedUnit: 'mph',
      visibility: 6.2,
      visibilityUnit: 'miles',
      pressure: 1015,
      pressureUnit: 'mb',
      timestamp: 'Friday, Feb 27, 2026 - 12:28 PM PST',
    },
    restaurants: {
      favorites: [
        {
          id: 'JffIqp7xncYtwehx0trCGg',
          name: 'Kappo Miyabi',
          location: 'Santa Monica',
          address: '702 Arizona Ave, Ste BB',
          city: 'Santa Monica, CA 90401',
          phone: '(310) 260-0085',
          type: 'Japanese (Sushi, Izakaya)',
          price: '$$$',
          rating: 4.3,
          reviewCount: 1140,
          summary: 'Japanese izakaya with cozy ambiance known for fresh fish and standout albacore roll.',
        },
        {
          id: 'lD8YBJ29CQ6Oftzmef0P5w',
          name: "The Butcher's Daughter",
          location: 'Venice',
          address: '1205 Abbot Kinney Blvd',
          city: 'Venice, CA 90291',
          phone: '(310) 981-3004',
          type: 'Breakfast & Brunch, Plant-based',
          price: '$$',
          rating: 3.9,
          reviewCount: 2274,
        },
      ],
      preferredTimes: ['1:00 PM', '2:00 PM'],
      lastChecked: 'Friday, Feb 27, 2026 - 12:33 PM PST',
    },
  },
)

// ---------------------------------------------------------------------------
// All demos indexed by name
// ---------------------------------------------------------------------------

export const DEMO_SURFACES: Record<string, { label: string; surface: SurfaceState }> = {
  drive_lax: { label: 'Drive to LAX', surface: DRIVE_TIME_LAX_SURFACE },
  expenses: { label: 'Expense Tracker', surface: EXPENSE_TRACKER_SURFACE },
  habits: { label: 'Habit Tracker', surface: HABIT_TRACKER_SURFACE },
  support: { label: 'Support Tickets', surface: SUPPORT_TICKETS_SURFACE },
  flights: { label: 'Flight Search', surface: FLIGHT_SEARCH_SURFACE },
  email: { label: 'Email Dashboard', surface: EMAIL_DASHBOARD_SURFACE },
  analytics: { label: 'Sales Analytics', surface: ANALYTICS_SURFACE },
  scheduler: { label: 'Meeting Scheduler', surface: SCHEDULER_SURFACE },
  project: { label: 'Project Overview', surface: PROJECT_OVERVIEW_SURFACE },
}

export function getAllDemoSurfaces(): Map<string, SurfaceState> {
  const map = new Map<string, SurfaceState>()
  for (const entry of Object.values(DEMO_SURFACES)) {
    map.set(entry.surface.surfaceId, entry.surface)
  }
  return map
}
