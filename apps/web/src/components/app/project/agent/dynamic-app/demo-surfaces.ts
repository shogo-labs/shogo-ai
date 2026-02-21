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
    { id: 'root', component: 'Column', children: ['metrics_row', 'sep', 'email_table_section'], gap: 'lg' },
    {
      id: 'metrics_row', component: 'Grid', columns: 4, gap: 'md',
      children: ['m_total', 'm_unread', 'm_flagged', 'm_drafts'],
    },
    { id: 'm_total', component: 'Metric', label: 'Total', value: { path: '/stats/total' }, description: 'Last 24 hours' },
    { id: 'm_unread', component: 'Metric', label: 'Unread', value: { path: '/stats/unread' }, trend: 'up', trendValue: '+12' },
    { id: 'm_flagged', component: 'Metric', label: 'Flagged', value: { path: '/stats/flagged' }, trend: 'neutral' },
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
    { id: 'kpi_rev', component: 'Metric', label: 'Revenue', value: '$2.4M', trend: 'up', trendValue: '+18%' },
    { id: 'kpi_orders', component: 'Metric', label: 'Orders', value: '18,200', trend: 'up', trendValue: '+7%' },
    { id: 'kpi_aov', component: 'Metric', label: 'Avg Order Value', value: '$132', trend: 'down', trendValue: '-3%' },
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
// All demos indexed by name
// ---------------------------------------------------------------------------

export const DEMO_SURFACES: Record<string, { label: string; surface: SurfaceState }> = {
  flights: { label: 'Flight Search', surface: FLIGHT_SEARCH_SURFACE },
  email: { label: 'Email Dashboard', surface: EMAIL_DASHBOARD_SURFACE },
  analytics: { label: 'Sales Analytics', surface: ANALYTICS_SURFACE },
  scheduler: { label: 'Meeting Scheduler', surface: SCHEDULER_SURFACE },
}

export function getAllDemoSurfaces(): Map<string, SurfaceState> {
  const map = new Map<string, SurfaceState>()
  for (const entry of Object.values(DEMO_SURFACES)) {
    map.set(entry.surface.surfaceId, entry.surface)
  }
  return map
}
