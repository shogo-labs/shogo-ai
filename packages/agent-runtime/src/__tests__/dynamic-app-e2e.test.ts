/**
 * Dynamic App — End-to-End Tests
 *
 * Tests the full dynamic app flow:
 * 1. Manager-level surface creation, component updates, data binding, actions
 * 2. Agent gateway integration — agent uses canvas_* tools to build UIs
 * 3. Realistic UI scenarios: flight search, email dashboard, data analytics
 *
 * These tests exercise the same code paths that run in production when
 * an agent builds a dynamic UI and a user interacts with it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { DynamicAppManager, getByPointer } from '../dynamic-app-manager'
import { getDynamicAppManager, resetDynamicAppManager } from '../dynamic-app-manager'
import type { DynamicAppMessage, ComponentDefinition } from '../dynamic-app-types'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = '/tmp/test-dynamic-app-e2e'

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      loopDetection: false,
    })
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agent\nYou are a helpful agent with canvas capabilities.')
  writeFileSync(join(TEST_DIR, 'SOUL.md'), '# Soul\nBe concise and visual.')
  writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\nDynamic App Agent')
  writeFileSync(join(TEST_DIR, 'USER.md'), '# User\nTest User')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\n')
}

function collectSSE(manager: DynamicAppManager): DynamicAppMessage[] {
  const messages: DynamicAppMessage[] = []
  manager.addClient((msg) => messages.push(msg))
  return messages
}

// ============================================================================
// 1. Flight Search UI
// ============================================================================

describe('Dynamic App E2E: Flight Search', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a complete flight search results interface', () => {
    const sse = collectSSE(manager)

    // Step 1: Create surface
    manager.createSurface('flights', 'Flight Search Results')

    // Step 2: Define component tree
    const components: ComponentDefinition[] = [
      {
        id: 'root',
        component: 'Column',
        children: ['header', 'results_grid'],
        gap: 'lg',
      },
      {
        id: 'header',
        component: 'Row',
        children: ['title', 'subtitle'],
        align: 'baseline',
        justify: 'between',
      },
      {
        id: 'title',
        component: 'Text',
        text: 'SFO → JFK',
        variant: 'h2',
      },
      {
        id: 'subtitle',
        component: 'Text',
        text: { path: '/search/date' },
        variant: 'muted',
      },
      {
        id: 'results_grid',
        component: 'Column',
        children: ['flight_1', 'flight_2', 'flight_3'],
        gap: 'md',
      },
      // Flight cards
      {
        id: 'flight_1',
        component: 'Card',
        title: { path: '/flights/0/airline' },
        description: { path: '/flights/0/times' },
        children: ['f1_row'],
      },
      {
        id: 'f1_row',
        component: 'Row',
        children: ['f1_price', 'f1_duration', 'f1_book'],
        align: 'center',
        justify: 'between',
      },
      {
        id: 'f1_price',
        component: 'Text',
        text: { path: '/flights/0/price' },
        variant: 'large',
      },
      {
        id: 'f1_duration',
        component: 'Badge',
        text: { path: '/flights/0/duration' },
        variant: 'secondary',
      },
      {
        id: 'f1_book',
        component: 'Button',
        label: 'Book Flight',
        variant: 'default',
        action: { name: 'book_flight', context: { flightId: { path: '/flights/0/id' } } },
      },
      // Flight 2
      {
        id: 'flight_2',
        component: 'Card',
        title: { path: '/flights/1/airline' },
        description: { path: '/flights/1/times' },
        children: ['f2_row'],
      },
      {
        id: 'f2_row',
        component: 'Row',
        children: ['f2_price', 'f2_duration', 'f2_book'],
        align: 'center',
        justify: 'between',
      },
      {
        id: 'f2_price',
        component: 'Text',
        text: { path: '/flights/1/price' },
        variant: 'large',
      },
      {
        id: 'f2_duration',
        component: 'Badge',
        text: { path: '/flights/1/duration' },
        variant: 'secondary',
      },
      {
        id: 'f2_book',
        component: 'Button',
        label: 'Book Flight',
        action: { name: 'book_flight', context: { flightId: { path: '/flights/1/id' } } },
      },
      // Flight 3
      {
        id: 'flight_3',
        component: 'Card',
        title: { path: '/flights/2/airline' },
        description: { path: '/flights/2/times' },
        children: ['f3_row'],
      },
      {
        id: 'f3_row',
        component: 'Row',
        children: ['f3_price', 'f3_book'],
        align: 'center',
        justify: 'between',
      },
      {
        id: 'f3_price',
        component: 'Text',
        text: { path: '/flights/2/price' },
        variant: 'large',
      },
      {
        id: 'f3_book',
        component: 'Button',
        label: 'Book Flight',
        action: { name: 'book_flight', context: { flightId: { path: '/flights/2/id' } } },
      },
    ]

    manager.updateComponents('flights', components)

    // Step 3: Populate data model
    manager.updateData('flights', '/', {
      search: { date: 'March 15, 2026' },
      flights: [
        { id: 'UA456', airline: 'United Airlines', times: '6:00 AM – 2:30 PM', price: '$299', duration: '5h 30m' },
        { id: 'DL789', airline: 'Delta Air Lines', times: '9:15 AM – 5:45 PM', price: '$349', duration: '5h 30m' },
        { id: 'AA102', airline: 'American Airlines', times: '12:00 PM – 8:15 PM', price: '$275', duration: '5h 15m' },
      ],
    })

    // Verify SSE messages
    expect(sse).toHaveLength(3)
    expect(sse[0].type).toBe('createSurface')
    expect(sse[1].type).toBe('updateComponents')
    expect(sse[2].type).toBe('updateData')

    // Verify state
    const surface = manager.getSurface('flights')!
    expect(surface.components.size).toBe(components.length)
    expect(surface.dataModel).toHaveProperty('flights')
    expect((surface.dataModel as any).flights).toHaveLength(3)

    // Verify data binding resolution
    const f1Price = surface.components.get('f1_price')!
    expect(f1Price.text).toEqual({ path: '/flights/0/price' })
    expect(getByPointer(surface.dataModel, '/flights/0/price')).toBe('$299')

    // Step 4: Simulate user clicking "Book Flight" for the cheapest option
    const bookAction = {
      surfaceId: 'flights',
      name: 'book_flight',
      context: { flightId: 'AA102' },
      timestamp: new Date().toISOString(),
    }

    // Deliver and wait for it
    const waitPromise = manager.waitForAction('flights', 'book_flight')
    manager.deliverAction(bookAction)

    return waitPromise.then((event) => {
      expect(event).not.toBeNull()
      expect(event!.name).toBe('book_flight')
      expect(event!.context).toEqual({ flightId: 'AA102' })
    })
  })

  test('updates flight prices in real-time without resending components', () => {
    manager.createSurface('flights')
    manager.updateComponents('flights', [
      { id: 'root', component: 'Column', children: ['price_display'] },
      { id: 'price_display', component: 'Text', text: { path: '/flights/0/price' } },
    ])
    manager.updateData('flights', '/', { flights: [{ price: '$299' }] })

    // Verify initial price
    expect(getByPointer(manager.getSurface('flights')!.dataModel, '/flights/0/price')).toBe('$299')

    // Update just the price
    manager.updateData('flights', '/flights/0/price', '$249')

    expect(getByPointer(manager.getSurface('flights')!.dataModel, '/flights/0/price')).toBe('$249')

    // Components unchanged — still 2
    expect(manager.getSurface('flights')!.components.size).toBe(2)
  })
})

// ============================================================================
// 2. Email Dashboard UI
// ============================================================================

describe('Dynamic App E2E: Email Dashboard', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a multi-section email dashboard with metrics and lists', () => {
    const sse = collectSSE(manager)

    manager.createSurface('email_dashboard', 'Email Dashboard')

    manager.updateComponents('email_dashboard', [
      {
        id: 'root',
        component: 'Column',
        children: ['metrics_row', 'separator', 'tabs_container'],
        gap: 'lg',
      },
      // Metrics row
      {
        id: 'metrics_row',
        component: 'Grid',
        columns: 4,
        gap: 'md',
        children: ['metric_total', 'metric_unread', 'metric_flagged', 'metric_drafts'],
      },
      {
        id: 'metric_total',
        component: 'Metric',
        label: 'Total Emails',
        value: { path: '/stats/total' },
        description: 'Last 24 hours',
      },
      {
        id: 'metric_unread',
        component: 'Metric',
        label: 'Unread',
        value: { path: '/stats/unread' },
        trend: 'up',
        trendValue: '+12',
      },
      {
        id: 'metric_flagged',
        component: 'Metric',
        label: 'Flagged',
        value: { path: '/stats/flagged' },
        trend: 'neutral',
      },
      {
        id: 'metric_drafts',
        component: 'Metric',
        label: 'Drafts',
        value: { path: '/stats/drafts' },
      },
      { id: 'separator', component: 'Separator' },
      // Tabs for categories
      {
        id: 'tabs_container',
        component: 'Tabs',
        tabs: [
          { id: 'important', label: 'Important' },
          { id: 'updates', label: 'Updates' },
          { id: 'social', label: 'Social' },
        ],
        children: ['important_panel', 'updates_panel', 'social_panel'],
      },
      {
        id: 'important_panel',
        component: 'Column',
        children: ['imp_table'],
        gap: 'sm',
      },
      {
        id: 'imp_table',
        component: 'Table',
        columns: [
          { key: 'from', label: 'From', width: '25%' },
          { key: 'subject', label: 'Subject' },
          { key: 'time', label: 'Time', width: '15%', align: 'right' },
        ],
        rows: { path: '/emails/important' },
        striped: true,
      },
      {
        id: 'updates_panel',
        component: 'Column',
        children: ['upd_alert', 'upd_table'],
        gap: 'sm',
      },
      {
        id: 'upd_alert',
        component: 'Alert',
        title: 'Newsletter digest ready',
        description: '5 newsletters summarized for you',
        variant: 'default',
      },
      {
        id: 'upd_table',
        component: 'Table',
        columns: [
          { key: 'from', label: 'From' },
          { key: 'subject', label: 'Subject' },
        ],
        rows: { path: '/emails/updates' },
      },
      {
        id: 'social_panel',
        component: 'Text',
        text: 'No social emails today.',
        variant: 'muted',
      },
    ])

    manager.updateData('email_dashboard', '/', {
      stats: { total: 47, unread: 12, flagged: 3, drafts: 2 },
      emails: {
        important: [
          { from: 'CEO', subject: 'Q4 Board Deck Review', time: '9:30 AM' },
          { from: 'Finance', subject: 'Budget approval needed', time: '8:15 AM' },
          { from: 'Engineering', subject: 'Prod incident P1 resolved', time: '7:42 AM' },
        ],
        updates: [
          { from: 'GitHub', subject: '3 PRs need review' },
          { from: 'Jira', subject: 'Sprint 42 starts tomorrow' },
        ],
      },
    })

    // Verify structure
    const surface = manager.getSurface('email_dashboard')!
    expect(surface.components.size).toBe(14)
    expect((surface.dataModel as any).stats.total).toBe(47)
    expect((surface.dataModel as any).emails.important).toHaveLength(3)

    // Verify SSE broadcast
    expect(sse).toHaveLength(3)

    // Simulate incremental update — new email arrives
    manager.updateData('email_dashboard', '/stats/unread', 13)
    expect(getByPointer(surface.dataModel, '/stats/unread')).toBe(13)
    expect(sse).toHaveLength(4) // +1 for the data update
    expect(sse[3].type).toBe('updateData')
  })
})

// ============================================================================
// 3. Data Analytics Dashboard
// ============================================================================

describe('Dynamic App E2E: Data Analytics Dashboard', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a dashboard with charts, metrics, and a data table', () => {
    manager.createSurface('analytics', 'Sales Analytics')

    manager.updateComponents('analytics', [
      {
        id: 'root',
        component: 'Column',
        children: ['title_row', 'kpi_grid', 'chart_section', 'details_table'],
        gap: 'lg',
      },
      {
        id: 'title_row',
        component: 'Row',
        children: ['dash_title', 'period_badge'],
        align: 'center',
        justify: 'between',
      },
      { id: 'dash_title', component: 'Text', text: 'Sales Analytics', variant: 'h2' },
      { id: 'period_badge', component: 'Badge', text: 'Q4 2025', variant: 'outline' },
      // KPI Grid
      {
        id: 'kpi_grid',
        component: 'Grid',
        columns: 3,
        children: ['kpi_revenue', 'kpi_orders', 'kpi_aov'],
      },
      {
        id: 'kpi_revenue',
        component: 'Metric',
        label: 'Revenue',
        value: { path: '/kpis/revenue' },
        unit: 'USD',
        trend: 'up',
        trendValue: '+18%',
      },
      {
        id: 'kpi_orders',
        component: 'Metric',
        label: 'Orders',
        value: { path: '/kpis/orders' },
        trend: 'up',
        trendValue: '+7%',
      },
      {
        id: 'kpi_aov',
        component: 'Metric',
        label: 'Avg Order Value',
        value: { path: '/kpis/aov' },
        unit: 'USD',
        trend: 'down',
        trendValue: '-3%',
      },
      // Chart
      {
        id: 'chart_section',
        component: 'Card',
        title: 'Monthly Revenue',
        children: ['revenue_chart'],
      },
      {
        id: 'revenue_chart',
        component: 'Chart',
        type: 'bar',
        data: { path: '/chartData' },
        height: 250,
      },
      // Details table
      {
        id: 'details_table',
        component: 'Card',
        title: 'Top Products',
        children: ['products_table'],
      },
      {
        id: 'products_table',
        component: 'Table',
        columns: [
          { key: 'name', label: 'Product' },
          { key: 'units', label: 'Units Sold', align: 'right' },
          { key: 'revenue', label: 'Revenue', align: 'right' },
        ],
        rows: { path: '/topProducts' },
        striped: true,
      },
    ])

    manager.updateData('analytics', '/', {
      kpis: { revenue: '2.4M', orders: '18,200', aov: '$132' },
      chartData: [
        { label: 'Oct', value: 580000 },
        { label: 'Nov', value: 720000 },
        { label: 'Dec', value: 1100000 },
      ],
      topProducts: [
        { name: 'Widget Pro', units: 4200, revenue: '$554K' },
        { name: 'GadgetX', units: 3100, revenue: '$410K' },
        { name: 'DataSync', units: 2800, revenue: '$370K' },
      ],
    })

    const surface = manager.getSurface('analytics')!
    expect(surface.components.size).toBe(12)
    expect((surface.dataModel as any).kpis.revenue).toBe('2.4M')
    expect((surface.dataModel as any).topProducts).toHaveLength(3)
  })
})

// ============================================================================
// 4. Interactive Form
// ============================================================================

describe('Dynamic App E2E: Interactive Form', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a meeting scheduler form with user input and submit action', () => {
    manager.createSurface('scheduler', 'Schedule Meeting')

    manager.updateComponents('scheduler', [
      {
        id: 'root',
        component: 'Card',
        title: 'Schedule a Meeting',
        description: 'Pick a time slot that works for you',
        children: ['form_body'],
      },
      {
        id: 'form_body',
        component: 'Column',
        children: ['title_field', 'date_select', 'time_picker', 'attendees_field', 'submit_row'],
        gap: 'md',
      },
      {
        id: 'title_field',
        component: 'TextField',
        label: 'Meeting Title',
        placeholder: 'e.g. Sprint Planning',
        value: { path: '/form/title' },
      },
      {
        id: 'date_select',
        component: 'Select',
        label: 'Date',
        options: [
          { label: 'Monday, Mar 16', value: '2026-03-16' },
          { label: 'Tuesday, Mar 17', value: '2026-03-17' },
          { label: 'Wednesday, Mar 18', value: '2026-03-18' },
        ],
        value: { path: '/form/date' },
        placeholder: 'Select a date',
      },
      {
        id: 'time_picker',
        component: 'ChoicePicker',
        label: 'Available Slots',
        options: [
          { label: '9:00 AM', value: '09:00' },
          { label: '10:30 AM', value: '10:30' },
          { label: '2:00 PM', value: '14:00' },
          { label: '3:30 PM', value: '15:30' },
        ],
        value: { path: '/form/time' },
      },
      {
        id: 'attendees_field',
        component: 'TextField',
        label: 'Attendees',
        placeholder: 'Comma-separated emails',
      },
      {
        id: 'submit_row',
        component: 'Row',
        children: ['cancel_btn', 'submit_btn'],
        justify: 'end',
        gap: 'sm',
      },
      {
        id: 'cancel_btn',
        component: 'Button',
        label: 'Cancel',
        variant: 'outline',
        action: { name: 'cancel' },
      },
      {
        id: 'submit_btn',
        component: 'Button',
        label: 'Schedule Meeting',
        variant: 'default',
        action: {
          name: 'schedule',
          context: {
            title: { path: '/form/title' },
            date: { path: '/form/date' },
            time: { path: '/form/time' },
          },
        },
      },
    ])

    manager.updateData('scheduler', '/', {
      form: { title: '', date: '', time: '' },
    })

    // Verify
    const surface = manager.getSurface('scheduler')!
    expect(surface.components.size).toBe(9)
    expect(surface.components.get('time_picker')!.component).toBe('ChoicePicker')

    // Simulate user filling form and clicking submit
    manager.updateData('scheduler', '/form/title', 'Sprint Planning')
    manager.updateData('scheduler', '/form/date', '2026-03-16')
    manager.updateData('scheduler', '/form/time', '10:30')

    expect(getByPointer(surface.dataModel, '/form/title')).toBe('Sprint Planning')
    expect(getByPointer(surface.dataModel, '/form/date')).toBe('2026-03-16')
    expect(getByPointer(surface.dataModel, '/form/time')).toBe('10:30')
  })

  test('action wait resolves when user submits form', async () => {
    manager.createSurface('form')
    manager.updateComponents('form', [
      { id: 'root', component: 'Column', children: ['btn'] },
      { id: 'btn', component: 'Button', label: 'Submit', action: { name: 'submit' } },
    ])

    // Start waiting before action arrives
    const waitPromise = manager.waitForAction('form', 'submit')

    // Simulate delayed user click
    setTimeout(() => {
      manager.deliverAction({
        surfaceId: 'form',
        name: 'submit',
        context: { formData: { name: 'Alice' } },
        timestamp: new Date().toISOString(),
      })
    }, 50)

    const event = await waitPromise
    expect(event).not.toBeNull()
    expect(event!.name).toBe('submit')
    expect(event!.context).toEqual({ formData: { name: 'Alice' } })
  })
})

// ============================================================================
// 5. Multi-Surface Management
// ============================================================================

describe('Dynamic App E2E: Multi-Surface', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('manages multiple surfaces independently', () => {
    manager.createSurface('sidebar', 'Navigation')
    manager.createSurface('main', 'Main Content')
    manager.createSurface('chat', 'Chat Panel')

    expect(manager.listSurfaces()).toEqual(['sidebar', 'main', 'chat'])

    // Update each independently
    manager.updateComponents('sidebar', [
      { id: 'root', component: 'Column', children: ['nav1', 'nav2'] },
      { id: 'nav1', component: 'Button', label: 'Dashboard', action: { name: 'nav', context: { page: 'dashboard' } } },
      { id: 'nav2', component: 'Button', label: 'Settings', action: { name: 'nav', context: { page: 'settings' } } },
    ])

    manager.updateComponents('main', [
      { id: 'root', component: 'Text', text: 'Welcome to the dashboard', variant: 'h2' },
    ])

    expect(manager.getSurface('sidebar')!.components.size).toBe(3)
    expect(manager.getSurface('main')!.components.size).toBe(1)
    expect(manager.getSurface('chat')!.components.size).toBe(0)

    // Delete one surface
    manager.deleteSurface('chat')
    expect(manager.listSurfaces()).toEqual(['sidebar', 'main'])
  })

  test('state snapshot captures all surfaces for reconnection', () => {
    manager.createSurface('s1', 'Surface One')
    manager.updateComponents('s1', [
      { id: 'root', component: 'Text', text: 'Hello' },
    ])
    manager.updateData('s1', '/', { count: 1 })

    manager.createSurface('s2', 'Surface Two')
    manager.updateComponents('s2', [
      { id: 'root', component: 'Column', children: ['child'] },
      { id: 'child', component: 'Badge', text: 'Active', variant: 'default' },
    ])

    const state = manager.getState()
    const s1 = state.surfaces.s1 as any
    const s2 = state.surfaces.s2 as any

    expect(s1.title).toBe('Surface One')
    expect(Object.keys(s1.components)).toHaveLength(1)
    expect(s1.dataModel).toEqual({ count: 1 })

    expect(s2.title).toBe('Surface Two')
    expect(Object.keys(s2.components)).toHaveLength(2)
  })
})

// ============================================================================
// 6. Agent Gateway Integration — Canvas Tools
// ============================================================================

describe('Dynamic App E2E: Agent Gateway Canvas Tools', () => {
  let gateway: AgentGateway

  beforeEach(() => {
    setupWorkspace()
    resetDynamicAppManager()
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
    resetDynamicAppManager()
  })

  test('agent creates a surface, adds components, and populates data via tool calls', async () => {
    const mockStream = createMockStreamFn([
      // Step 1: Agent creates surface
      buildToolUseResponse([{
        name: 'canvas_create',
        arguments: { surfaceId: 'weather', title: 'Weather Forecast' },
        id: 'toolu_1',
      }]),
      // Step 2: Agent adds components
      buildToolUseResponse([{
        name: 'canvas_update',
        arguments: {
          surfaceId: 'weather',
          components: [
            { id: 'root', component: 'Column', children: ['temp', 'condition', 'humidity'] },
            { id: 'temp', component: 'Text', text: { path: '/weather/temp' }, variant: 'h1' },
            { id: 'condition', component: 'Badge', text: { path: '/weather/condition' } },
            { id: 'humidity', component: 'Text', text: { path: '/weather/humidity' }, variant: 'muted' },
          ],
        },
        id: 'toolu_2',
      }]),
      // Step 3: Agent populates data
      buildToolUseResponse([{
        name: 'canvas_data',
        arguments: {
          surfaceId: 'weather',
          path: '/',
          value: {
            weather: {
              temp: '72°F',
              condition: 'Sunny',
              humidity: 'Humidity: 45%',
            },
          },
        },
        id: 'toolu_3',
      }]),
      // Step 4: Agent responds with text
      buildTextResponse('I\'ve displayed the current weather on the canvas. It\'s 72°F and sunny!'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('What\'s the weather today?')

    expect(response).toContain('72°F')
    expect(response).toContain('sunny')

    // Verify the surface was created in the singleton manager
    const mgr = getDynamicAppManager()
    expect(mgr.listSurfaces()).toContain('weather')

    const surface = mgr.getSurface('weather')!
    expect(surface.title).toBe('Weather Forecast')
    expect(surface.components.size).toBe(4)
    expect(getByPointer(surface.dataModel, '/weather/temp')).toBe('72°F')
    expect(getByPointer(surface.dataModel, '/weather/condition')).toBe('Sunny')
  })

  test('agent creates a flight search UI and waits for user selection', async () => {
    const mockStream = createMockStreamFn([
      // Agent creates surface
      buildToolUseResponse([{
        name: 'canvas_create',
        arguments: { surfaceId: 'flights', title: 'Flight Results' },
        id: 'toolu_1',
      }]),
      // Agent adds flight cards
      buildToolUseResponse([{
        name: 'canvas_update',
        arguments: {
          surfaceId: 'flights',
          components: [
            { id: 'root', component: 'Column', children: ['header', 'f1', 'f2'], gap: 'md' },
            { id: 'header', component: 'Text', text: 'SFO → JFK — 3 flights found', variant: 'h3' },
            { id: 'f1', component: 'Card', title: 'United $299', children: ['f1_btn'] },
            { id: 'f1_btn', component: 'Button', label: 'Select', action: { name: 'select_flight', context: { flightId: 'UA456' } } },
            { id: 'f2', component: 'Card', title: 'Delta $349', children: ['f2_btn'] },
            { id: 'f2_btn', component: 'Button', label: 'Select', action: { name: 'select_flight', context: { flightId: 'DL789' } } },
          ],
        },
        id: 'toolu_2',
      }]),
      // Agent waits for user action
      buildToolUseResponse([{
        name: 'canvas_action_wait',
        arguments: { surfaceId: 'flights', actionName: 'select_flight', timeoutSeconds: 5 },
        id: 'toolu_3',
      }]),
      // After receiving action, agent responds
      buildTextResponse('You selected United flight UA456 at $299. Proceeding to booking...'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    // Simulate user clicking while agent is waiting
    setTimeout(() => {
      getDynamicAppManager().deliverAction({
        surfaceId: 'flights',
        name: 'select_flight',
        context: { flightId: 'UA456' },
        timestamp: new Date().toISOString(),
      })
    }, 200)

    const response = await gateway.processChatMessage('Find flights from SFO to JFK')

    expect(response).toContain('UA456')
    expect(response).toContain('booking')
  })

  test('agent updates data without resending layout', async () => {
    const mockStream = createMockStreamFn([
      // Create surface
      buildToolUseResponse([{
        name: 'canvas_create',
        arguments: { surfaceId: 'counter', title: 'Counter' },
        id: 'toolu_1',
      }]),
      // Add components
      buildToolUseResponse([{
        name: 'canvas_update',
        arguments: {
          surfaceId: 'counter',
          components: [
            { id: 'root', component: 'Column', children: ['count_display'] },
            { id: 'count_display', component: 'Metric', label: 'Count', value: { path: '/count' } },
          ],
        },
        id: 'toolu_2',
      }]),
      // Set initial data
      buildToolUseResponse([{
        name: 'canvas_data',
        arguments: { surfaceId: 'counter', path: '/count', value: 0 },
        id: 'toolu_3',
      }]),
      // Update count
      buildToolUseResponse([{
        name: 'canvas_data',
        arguments: { surfaceId: 'counter', path: '/count', value: 42 },
        id: 'toolu_4',
      }]),
      buildTextResponse('Counter updated to 42.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Show a counter and set it to 42')

    expect(response).toContain('42')

    const mgr = getDynamicAppManager()
    const surface = mgr.getSurface('counter')!
    expect(getByPointer(surface.dataModel, '/count')).toBe(42)
    expect(surface.components.size).toBe(2) // Components unchanged
  })

  test('agent deletes a surface when done', async () => {
    const mockStream = createMockStreamFn([
      buildToolUseResponse([{
        name: 'canvas_create',
        arguments: { surfaceId: 'temp', title: 'Temporary' },
        id: 'toolu_1',
      }]),
      buildToolUseResponse([{
        name: 'canvas_delete',
        arguments: { surfaceId: 'temp' },
        id: 'toolu_2',
      }]),
      buildTextResponse('Cleaned up the temporary display.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Show something then clean it up')

    expect(response).toContain('Cleaned up')
    expect(getDynamicAppManager().listSurfaces()).not.toContain('temp')
  })
})

// ============================================================================
// 7. SSE Replay on Reconnect
// ============================================================================

describe('Dynamic App E2E: SSE Reconnection Replay', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('new SSE client receives full state replay on connect', () => {
    // Build state before any client connects
    manager.createSurface('dash', 'Dashboard')
    manager.updateComponents('dash', [
      { id: 'root', component: 'Column', children: ['metric'] },
      { id: 'metric', component: 'Metric', label: 'Users', value: { path: '/users' } },
    ])
    manager.updateData('dash', '/', { users: 1500 })

    // Now connect a "late" client
    const replay: DynamicAppMessage[] = []
    manager.addClient((msg) => replay.push(msg))

    // The replay doesn't happen via addClient (it happens in the SSE endpoint)
    // So let's test getState instead, which is what the endpoint uses
    const state = manager.getState()
    const dashState = state.surfaces.dash as any

    expect(dashState.surfaceId).toBe('dash')
    expect(dashState.title).toBe('Dashboard')
    expect(Object.keys(dashState.components)).toHaveLength(2)
    expect(dashState.dataModel).toEqual({ users: 1500 })
  })
})

// ============================================================================
// 8. Complex Nested UI: Research Report
// ============================================================================

describe('Dynamic App E2E: Research Report', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a research report with accordion sections and progress tracking', () => {
    manager.createSurface('report', 'Research Report')

    manager.updateComponents('report', [
      {
        id: 'root',
        component: 'Column',
        children: ['header', 'progress_section', 'findings'],
        gap: 'lg',
      },
      // Header
      {
        id: 'header',
        component: 'Row',
        children: ['report_title', 'status_badge'],
        align: 'center',
        justify: 'between',
      },
      { id: 'report_title', component: 'Text', text: 'Market Analysis: EV Sector', variant: 'h2' },
      { id: 'status_badge', component: 'Badge', text: 'In Progress', variant: 'secondary' },
      // Progress
      {
        id: 'progress_section',
        component: 'Card',
        title: 'Research Progress',
        children: ['progress_chart'],
      },
      {
        id: 'progress_chart',
        component: 'Chart',
        type: 'progress',
        data: [
          { label: 'Data Collection', value: 100 },
          { label: 'Analysis', value: 75 },
          { label: 'Writing', value: 30 },
          { label: 'Review', value: 0 },
        ],
      },
      // Findings accordion
      {
        id: 'findings',
        component: 'Accordion',
        children: ['section_market', 'section_players', 'section_forecast'],
      },
      {
        id: 'section_market',
        component: 'AccordionItem',
        title: 'Market Size & Growth',
        defaultOpen: true,
        children: ['market_content'],
      },
      {
        id: 'market_content',
        component: 'Column',
        children: ['market_text', 'market_metrics'],
        gap: 'sm',
      },
      {
        id: 'market_text',
        component: 'Text',
        text: 'The global EV market reached $388B in 2025, growing at 21% CAGR.',
      },
      {
        id: 'market_metrics',
        component: 'Grid',
        columns: 2,
        children: ['m1', 'm2'],
      },
      { id: 'm1', component: 'Metric', label: 'Market Size', value: '$388B', trend: 'up', trendValue: '+21%' },
      { id: 'm2', component: 'Metric', label: 'Units Sold', value: '14.2M', trend: 'up', trendValue: '+35%' },
      {
        id: 'section_players',
        component: 'AccordionItem',
        title: 'Key Players',
        children: ['players_table'],
      },
      {
        id: 'players_table',
        component: 'Table',
        columns: [
          { key: 'company', label: 'Company' },
          { key: 'share', label: 'Market Share', align: 'right' },
          { key: 'growth', label: 'YoY Growth', align: 'right' },
        ],
        rows: [
          { company: 'Tesla', share: '19.5%', growth: '+8%' },
          { company: 'BYD', share: '17.2%', growth: '+62%' },
          { company: 'VW Group', share: '8.1%', growth: '+12%' },
          { company: 'GM', share: '5.4%', growth: '+45%' },
        ],
      },
      {
        id: 'section_forecast',
        component: 'AccordionItem',
        title: '2026 Forecast',
        children: ['forecast_text'],
      },
      {
        id: 'forecast_text',
        component: 'Alert',
        title: 'Strong Growth Expected',
        description: 'EV market projected to reach $470B by end of 2026, driven by new model launches and expanding charging infrastructure.',
        icon: 'trending-up',
      },
    ])

    const surface = manager.getSurface('report')!
    expect(surface.components.size).toBe(17)
    expect(surface.components.get('section_market')!.component).toBe('AccordionItem')
    expect(surface.components.get('progress_chart')!.component).toBe('Chart')
    expect((surface.components.get('players_table')!.rows as any[])).toHaveLength(4)
  })
})

// ============================================================================
// 9. DataList with Template Rendering
// ============================================================================

describe('Dynamic App E2E: DataList Template', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('builds a notification feed using DataList with template children', () => {
    manager.createSurface('notifications', 'Notifications')

    manager.updateComponents('notifications', [
      {
        id: 'root',
        component: 'Column',
        children: ['header', 'feed'],
        gap: 'md',
      },
      { id: 'header', component: 'Text', text: 'Recent Notifications', variant: 'h3' },
      {
        id: 'feed',
        component: 'DataList',
        children: { path: '/notifications', templateId: 'notif_card' },
      },
      // Template for each notification
      {
        id: 'notif_card',
        component: 'Card',
        title: { path: 'title' },
        description: { path: 'message' },
        children: ['notif_meta'],
      },
      {
        id: 'notif_meta',
        component: 'Row',
        children: ['notif_time', 'notif_type'],
        justify: 'between',
        align: 'center',
      },
      { id: 'notif_time', component: 'Text', text: { path: 'time' }, variant: 'caption' },
      { id: 'notif_type', component: 'Badge', text: { path: 'type' }, variant: 'outline' },
    ])

    manager.updateData('notifications', '/', {
      notifications: [
        { title: 'New PR Review', message: 'John requested review on #142', time: '2 min ago', type: 'github' },
        { title: 'Build Failed', message: 'CI pipeline failed on main branch', time: '15 min ago', type: 'ci' },
        { title: 'Meeting Reminder', message: 'Sprint planning in 30 minutes', time: '28 min ago', type: 'calendar' },
      ],
    })

    const surface = manager.getSurface('notifications')!
    expect(surface.components.size).toBe(7)
    expect((surface.dataModel as any).notifications).toHaveLength(3)

    // Verify template children reference pattern
    const feed = surface.components.get('feed')!
    expect(feed.children).toEqual({ path: '/notifications', templateId: 'notif_card' })
  })

  test('DataList updates when data changes without component changes', () => {
    manager.createSurface('list')
    manager.updateComponents('list', [
      { id: 'root', component: 'DataList', children: { path: '/items', templateId: 'item' } },
      { id: 'item', component: 'Text', text: { path: 'name' } },
    ])
    manager.updateData('list', '/', { items: [{ name: 'A' }, { name: 'B' }] })

    // Add a new item
    manager.updateData('list', '/items', [{ name: 'A' }, { name: 'B' }, { name: 'C' }])

    const surface = manager.getSurface('list')!
    expect((surface.dataModel as any).items).toHaveLength(3)
    expect(surface.components.size).toBe(2) // Template components unchanged
  })
})

// ============================================================================
// 10. Edge Cases
// ============================================================================

describe('Dynamic App E2E: Edge Cases', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  test('handles empty components gracefully', () => {
    manager.createSurface('empty')
    manager.updateComponents('empty', [])
    expect(manager.getSurface('empty')!.components.size).toBe(0)
  })

  test('handles deep JSON pointer paths', () => {
    manager.createSurface('deep')
    manager.updateData('deep', '/', { a: { b: { c: { d: 'found' } } } })
    expect(getByPointer(manager.getSurface('deep')!.dataModel, '/a/b/c/d')).toBe('found')

    manager.updateData('deep', '/a/b/c/d', 'updated')
    expect(getByPointer(manager.getSurface('deep')!.dataModel, '/a/b/c/d')).toBe('updated')
  })

  test('handles array indices in JSON pointer', () => {
    manager.createSurface('arr')
    manager.updateData('arr', '/', { items: ['a', 'b', 'c'] })
    expect(getByPointer(manager.getSurface('arr')!.dataModel, '/items/1')).toBe('b')

    manager.updateData('arr', '/items/1', 'B')
    expect(getByPointer(manager.getSurface('arr')!.dataModel, '/items/1')).toBe('B')
  })

  test('handles JSON Pointer escaped characters', () => {
    manager.createSurface('escaped')
    manager.updateData('escaped', '/', { 'a/b': { 'c~d': 'value' } })
    expect(getByPointer(manager.getSurface('escaped')!.dataModel, '/a~1b/c~0d')).toBe('value')
  })

  test('concurrent SSE clients all receive same messages', () => {
    const client1: DynamicAppMessage[] = []
    const client2: DynamicAppMessage[] = []
    const client3: DynamicAppMessage[] = []

    manager.addClient((msg) => client1.push(msg))
    manager.addClient((msg) => client2.push(msg))
    manager.addClient((msg) => client3.push(msg))

    manager.createSurface('s1')
    manager.updateComponents('s1', [{ id: 'root', component: 'Text', text: 'Hi' }])
    manager.updateData('s1', '/', { greeting: 'hello' })
    manager.deleteSurface('s1')

    for (const client of [client1, client2, client3]) {
      expect(client).toHaveLength(4)
      expect(client.map((m) => m.type)).toEqual([
        'createSurface', 'updateComponents', 'updateData', 'deleteSurface',
      ])
    }
  })

  test('action queue does not grow unbounded', () => {
    manager.createSurface('s1')

    // Deliver 150 actions without any waiters
    for (let i = 0; i < 150; i++) {
      manager.deliverAction({
        surfaceId: 's1',
        name: `action_${i}`,
        context: {},
        timestamp: new Date().toISOString(),
      })
    }

    // Queue should be capped at 100
    expect((manager as any).actionQueue.length).toBeLessThanOrEqual(100)
  })

  test('canvas_action_wait timeout returns null', async () => {
    manager.createSurface('s1')
    const event = await manager.waitForAction('s1', 'missing', 100)
    expect(event).toBeNull()
  })
})
