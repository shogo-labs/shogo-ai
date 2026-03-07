// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Managed API Runtime — Tests
 *
 * Tests the full managed API lifecycle:
 * 1. Schema definition → SQLite table creation → Hono route serving
 * 2. CRUD operations via the Hono routes
 * 3. Seeding, querying, filtering, sorting
 * 4. DynamicAppManager integration (applyApiSchema, seedApiData, queryApiData)
 * 5. Realistic use cases: stock dashboard, task tracker, feedback analyzer
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'fs'
import { ManagedApiRuntime, type ModelDefinition } from '../managed-api-runtime'
import { DynamicAppManager } from '../dynamic-app-manager'
import type { DynamicAppMessage } from '../dynamic-app-types'

const TEST_DIR = '/tmp/test-managed-api-runtime'

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
}

function collectSSE(manager: DynamicAppManager): DynamicAppMessage[] {
  const messages: DynamicAppMessage[] = []
  manager.addClient((msg) => messages.push(msg))
  return messages
}

// Helper to call the embedded Hono app directly
async function apiRequest(runtime: ManagedApiRuntime, method: string, path: string, body?: unknown) {
  const url = `http://localhost${path}`
  const req = new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await runtime.getApp().fetch(req)
  return res.json()
}

// ============================================================================
// 1. ManagedApiRuntime Core
// ============================================================================

describe('ManagedApiRuntime: Core', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'test', workDir: TEST_DIR })
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('applySchema creates tables and routes', () => {
    const models: ModelDefinition[] = [
      {
        name: 'Todo',
        fields: [
          { name: 'title', type: 'String' },
          { name: 'done', type: 'Boolean', default: false },
        ],
      },
    ]

    const result = runtime.applySchema(models)
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['Todo'])
    expect(result.endpoints.length).toBe(1)
    expect(result.endpoints[0].path).toBe('/api/todos')
    expect(runtime.isReady()).toBe(true)
  })

  test('applySchema handles multiple models', () => {
    const models: ModelDefinition[] = [
      { name: 'Stock', fields: [{ name: 'symbol', type: 'String', unique: true }, { name: 'name', type: 'String' }] },
      { name: 'PriceSnapshot', fields: [{ name: 'stockId', type: 'String' }, { name: 'price', type: 'Float' }, { name: 'volume', type: 'Int' }] },
    ]

    const result = runtime.applySchema(models)
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['Stock', 'PriceSnapshot'])
    expect(result.endpoints.length).toBe(2)
  })

  test('applySchema with reset drops and recreates tables', () => {
    const models: ModelDefinition[] = [
      { name: 'Todo', fields: [{ name: 'title', type: 'String' }] },
    ]

    runtime.applySchema(models)
    runtime.seed('Todo', [{ title: 'First' }])

    const beforeReset = runtime.query('Todo')
    expect(beforeReset.count).toBe(1)

    runtime.applySchema(models, true)
    const afterReset = runtime.query('Todo')
    expect(afterReset.count).toBe(0)
  })

  test('seed inserts records', () => {
    runtime.applySchema([
      { name: 'Todo', fields: [{ name: 'title', type: 'String' }, { name: 'done', type: 'Boolean', default: false }] },
    ])

    const result = runtime.seed('Todo', [
      { title: 'Buy milk' },
      { title: 'Write tests', done: true },
      { title: 'Deploy' },
    ])

    expect(result.ok).toBe(true)
    expect(result.inserted).toBe(3)
    expect(result.total).toBe(3)
  })

  test('seed with upsert updates existing records', () => {
    runtime.applySchema([
      { name: 'Todo', fields: [{ name: 'title', type: 'String' }, { name: 'done', type: 'Boolean' }] },
    ])

    runtime.seed('Todo', [{ id: 'todo-1', title: 'Original' }])
    runtime.seed('Todo', [{ id: 'todo-1', title: 'Updated', done: true }], true)

    const result = runtime.query('Todo', { where: { id: 'todo-1' } })
    expect(result.items.length).toBe(1)
    expect(result.items[0].title).toBe('Updated')
    expect(result.items[0].done).toBe(true)
  })

  test('query with filtering', () => {
    runtime.applySchema([
      { name: 'Task', fields: [{ name: 'title', type: 'String' }, { name: 'status', type: 'String' }] },
    ])

    runtime.seed('Task', [
      { title: 'Task A', status: 'todo' },
      { title: 'Task B', status: 'done' },
      { title: 'Task C', status: 'todo' },
    ])

    const todos = runtime.query('Task', { where: { status: 'todo' } })
    expect(todos.count).toBe(2)

    const done = runtime.query('Task', { where: { status: 'done' } })
    expect(done.count).toBe(1)
  })

  test('query with ordering and limit', () => {
    runtime.applySchema([
      { name: 'Item', fields: [{ name: 'name', type: 'String' }, { name: 'priority', type: 'Int' }] },
    ])

    runtime.seed('Item', [
      { name: 'Low', priority: 1 },
      { name: 'High', priority: 3 },
      { name: 'Medium', priority: 2 },
    ])

    const asc = runtime.query('Item', { orderBy: 'priority', limit: 2 })
    expect(asc.items.length).toBe(2)
    expect(asc.items[0].name).toBe('Low')
    expect(asc.items[1].name).toBe('Medium')

    const desc = runtime.query('Item', { orderBy: '-priority', limit: 1 })
    expect(desc.items[0].name).toBe('High')
  })

  test('getModelEndpointInfo returns correct metadata', () => {
    runtime.applySchema([
      { name: 'Todo', fields: [{ name: 'title', type: 'String' }, { name: 'done', type: 'Boolean' }] },
    ])

    const info = runtime.getModelEndpointInfo()
    expect(info.length).toBe(1)
    expect(info[0].name).toBe('Todo')
    expect(info[0].endpoint).toBe('/api/todos')
    expect(info[0].fields).toContain('id')
    expect(info[0].fields).toContain('title')
    expect(info[0].fields).toContain('done')
    expect(info[0].fields).toContain('createdAt')
  })
})

// ============================================================================
// 2. Hono CRUD Routes
// ============================================================================

describe('ManagedApiRuntime: Hono Routes', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'test', workDir: TEST_DIR })
    runtime.applySchema([
      {
        name: 'Todo',
        fields: [
          { name: 'title', type: 'String' },
          { name: 'done', type: 'Boolean', default: false },
          { name: 'priority', type: 'Int', default: 0 },
        ],
      },
    ])
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('POST creates a record', async () => {
    const res = await apiRequest(runtime, 'POST', '/api/todos', { title: 'Test todo' })
    expect(res.ok).toBe(true)
    expect(res.item.title).toBe('Test todo')
    expect(res.item.done).toBe(false)
    expect(res.item.id).toBeDefined()
    expect(res.item.createdAt).toBeDefined()
  })

  test('GET lists all records', async () => {
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'First' })
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'Second' })

    const res = await apiRequest(runtime, 'GET', '/api/todos')
    expect(res.ok).toBe(true)
    expect(res.items.length).toBe(2)
  })

  test('GET with query params filters results', async () => {
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'Active', done: false })
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'Completed', done: true })

    const res = await apiRequest(runtime, 'GET', '/api/todos?done=false')
    expect(res.ok).toBe(true)
    expect(res.items.length).toBe(1)
    expect(res.items[0].title).toBe('Active')
  })

  test('GET /:id returns a single record', async () => {
    const created = await apiRequest(runtime, 'POST', '/api/todos', { title: 'Specific' })
    const res = await apiRequest(runtime, 'GET', `/api/todos/${created.item.id}`)
    expect(res.ok).toBe(true)
    expect(res.item.title).toBe('Specific')
  })

  test('GET /:id returns 404 for missing record', async () => {
    const res = await apiRequest(runtime, 'GET', '/api/todos/nonexistent')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Not found')
  })

  test('PATCH updates a record', async () => {
    const created = await apiRequest(runtime, 'POST', '/api/todos', { title: 'Original' })
    const res = await apiRequest(runtime, 'PATCH', `/api/todos/${created.item.id}`, {
      title: 'Updated',
      done: true,
    })
    expect(res.ok).toBe(true)
    expect(res.item.title).toBe('Updated')
    expect(res.item.done).toBe(true)
  })

  test('DELETE removes a record', async () => {
    const created = await apiRequest(runtime, 'POST', '/api/todos', { title: 'To delete' })
    const deleteRes = await apiRequest(runtime, 'DELETE', `/api/todos/${created.item.id}`)
    expect(deleteRes.ok).toBe(true)

    const listRes = await apiRequest(runtime, 'GET', '/api/todos')
    expect(listRes.items.length).toBe(0)
  })

  test('GET /api/_models returns model metadata', async () => {
    const res = await apiRequest(runtime, 'GET', '/api/_models')
    expect(res.ok).toBe(true)
    expect(res.models.length).toBe(1)
    expect(res.models[0].name).toBe('Todo')
    expect(res.models[0].endpoint).toBe('/api/todos')
  })

  test('GET with orderBy sorts results', async () => {
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'Low', priority: 1 })
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'High', priority: 3 })
    await apiRequest(runtime, 'POST', '/api/todos', { title: 'Medium', priority: 2 })

    const res = await apiRequest(runtime, 'GET', '/api/todos?orderBy=priority')
    expect(res.items[0].title).toBe('Low')
    expect(res.items[2].title).toBe('High')
  })

  test('GET with limit caps results', async () => {
    for (let i = 0; i < 5; i++) {
      await apiRequest(runtime, 'POST', '/api/todos', { title: `Todo ${i}` })
    }

    const res = await apiRequest(runtime, 'GET', '/api/todos?limit=2')
    expect(res.items.length).toBe(2)
  })
})

// ============================================================================
// 3. DynamicAppManager Integration
// ============================================================================

describe('DynamicAppManager: API Integration', () => {
  let manager: DynamicAppManager
  const DAM_PERSIST = `${TEST_DIR}/dam-state.json`

  beforeEach(() => {
    cleanup()
    manager = new DynamicAppManager(DAM_PERSIST)
  })

  afterEach(() => {
    manager.clear()
  })

  test('applyApiSchema requires an existing surface', () => {
    const result = manager.applyApiSchema('nonexistent', [
      { name: 'Todo', fields: [{ name: 'title', type: 'String' }] },
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not exist')
  })

  test('full lifecycle: create surface → apply schema → seed → query', () => {
    const sse = collectSSE(manager)

    manager.createSurface('todo_app', 'Task Tracker')

    const schemaResult = manager.applyApiSchema('todo_app', [
      {
        name: 'Task',
        fields: [
          { name: 'title', type: 'String' },
          { name: 'status', type: 'String', default: 'todo' },
          { name: 'priority', type: 'Int', default: 0 },
        ],
      },
    ])
    expect(schemaResult.ok).toBe(true)

    const seedResult = manager.seedApiData('todo_app', 'Task', [
      { title: 'Design UI', status: 'done', priority: 1 },
      { title: 'Write tests', status: 'in_progress', priority: 2 },
      { title: 'Deploy', status: 'todo', priority: 3 },
    ])
    expect(seedResult.ok).toBe(true)
    expect((seedResult as any).inserted).toBe(3)

    const queryResult = manager.queryApiData('todo_app', 'Task', { where: { status: 'todo' } })
    expect(queryResult.ok).toBe(true)
    expect((queryResult as any).items.length).toBe(1)

    // Verify configureApi SSE message was broadcast
    const configureApiMsg = sse.find(m => m.type === 'configureApi')
    expect(configureApiMsg).toBeDefined()
    if (configureApiMsg && configureApiMsg.type === 'configureApi') {
      expect(configureApiMsg.models.length).toBe(1)
      expect(configureApiMsg.models[0].name).toBe('Task')
      expect(configureApiMsg.models[0].endpoint).toBe('/api/tasks')
    }
  })

  test('queryApiData with dataPath pushes results into surface data model', () => {
    const sse = collectSSE(manager)

    manager.createSurface('dashboard')
    manager.applyApiSchema('dashboard', [
      { name: 'Metric', fields: [{ name: 'name', type: 'String' }, { name: 'value', type: 'Float' }] },
    ])
    manager.seedApiData('dashboard', 'Metric', [
      { name: 'Revenue', value: 50000 },
      { name: 'Users', value: 1200 },
    ])

    manager.queryApiData('dashboard', 'Metric', {}, '/metrics')

    // Verify updateData SSE message was sent with query results
    const updateDataMsgs = sse.filter(m => m.type === 'updateData')
    const metricsUpdate = updateDataMsgs.find(m => m.type === 'updateData' && m.path === '/metrics')
    expect(metricsUpdate).toBeDefined()
    if (metricsUpdate && metricsUpdate.type === 'updateData') {
      const items = metricsUpdate.value as any[]
      expect(items.length).toBe(2)
    }
  })

  test('getRuntime returns the runtime for a surface', () => {
    manager.createSurface('app')
    manager.applyApiSchema('app', [
      { name: 'Item', fields: [{ name: 'name', type: 'String' }] },
    ])

    const runtime = manager.getRuntime('app')
    expect(runtime).toBeDefined()
    expect(runtime!.isReady()).toBe(true)
  })

  test('deleteSurface cleans up the runtime', () => {
    manager.createSurface('temp')
    manager.applyApiSchema('temp', [
      { name: 'Data', fields: [{ name: 'value', type: 'String' }] },
    ])

    expect(manager.getRuntime('temp')).toBeDefined()
    manager.deleteSurface('temp')
    expect(manager.getRuntime('temp')).toBeUndefined()
  })

  test('clear destroys all runtimes', () => {
    manager.createSurface('app1')
    manager.createSurface('app2')
    manager.applyApiSchema('app1', [{ name: 'A', fields: [{ name: 'x', type: 'String' }] }])
    manager.applyApiSchema('app2', [{ name: 'B', fields: [{ name: 'y', type: 'String' }] }])

    manager.clear()
    expect(manager.getRuntime('app1')).toBeUndefined()
    expect(manager.getRuntime('app2')).toBeUndefined()
  })
})

// ============================================================================
// 4. Use Case: Stock Dashboard
// ============================================================================

describe('Use Case: Stock Dashboard', () => {
  let manager: DynamicAppManager
  const STOCK_PERSIST = `${TEST_DIR}/stock-state.json`

  beforeEach(() => {
    cleanup()
    manager = new DynamicAppManager(STOCK_PERSIST)
  })

  afterEach(() => {
    manager.clear()
  })

  test('builds a stock portfolio dashboard with price snapshots', async () => {
    manager.createSurface('stock_dashboard', 'Portfolio Dashboard')

    // Define schema
    const schemaResult = manager.applyApiSchema('stock_dashboard', [
      {
        name: 'Stock',
        fields: [
          { name: 'symbol', type: 'String', unique: true },
          { name: 'name', type: 'String' },
          { name: 'sector', type: 'String' },
        ],
      },
      {
        name: 'PriceSnapshot',
        fields: [
          { name: 'stockSymbol', type: 'String' },
          { name: 'price', type: 'Float' },
          { name: 'volume', type: 'Int' },
        ],
      },
      {
        name: 'Portfolio',
        fields: [
          { name: 'stockSymbol', type: 'String' },
          { name: 'shares', type: 'Int' },
          { name: 'avgCost', type: 'Float' },
        ],
      },
    ])
    expect(schemaResult.ok).toBe(true)

    // Seed stocks
    manager.seedApiData('stock_dashboard', 'Stock', [
      { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology' },
      { symbol: 'MSFT', name: 'Microsoft Corp.', sector: 'Technology' },
      { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Automotive' },
    ])

    // Seed portfolio
    manager.seedApiData('stock_dashboard', 'Portfolio', [
      { stockSymbol: 'AAPL', shares: 50, avgCost: 150.25 },
      { stockSymbol: 'GOOGL', shares: 20, avgCost: 2800.00 },
      { stockSymbol: 'MSFT', shares: 100, avgCost: 300.50 },
    ])

    // Seed price snapshots (simulating periodic refresh)
    manager.seedApiData('stock_dashboard', 'PriceSnapshot', [
      { stockSymbol: 'AAPL', price: 178.50, volume: 45000000 },
      { stockSymbol: 'GOOGL', price: 2950.75, volume: 1200000 },
      { stockSymbol: 'MSFT', price: 380.20, volume: 22000000 },
      { stockSymbol: 'TSLA', price: 250.10, volume: 80000000 },
    ])

    // Query via the Hono routes
    const runtime = manager.getRuntime('stock_dashboard')!
    const stocks = await apiRequest(runtime, 'GET', '/api/stocks')
    expect(stocks.items.length).toBe(4)

    const techStocks = await apiRequest(runtime, 'GET', '/api/stocks?sector=Technology')
    expect(techStocks.items.length).toBe(3)

    const portfolios = await apiRequest(runtime, 'GET', '/api/portfolios')
    expect(portfolios.items.length).toBe(3)

    // Simulate agent pushing derived data into surface data model
    manager.queryApiData('stock_dashboard', 'Portfolio', {}, '/portfolioItems')
    const surface = manager.getSurface('stock_dashboard')
    expect(surface).toBeDefined()
    expect((surface!.dataModel as any).portfolioItems).toBeDefined()
    expect((surface!.dataModel as any).portfolioItems.length).toBe(3)
  })
})

// ============================================================================
// 5. Use Case: Task Tracker (Full CRUD)
// ============================================================================

describe('Use Case: Task Tracker', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'tasks', workDir: TEST_DIR })
    runtime.applySchema([
      {
        name: 'Task',
        fields: [
          { name: 'title', type: 'String' },
          { name: 'description', type: 'String', optional: true },
          { name: 'status', type: 'String', default: 'todo' },
          { name: 'priority', type: 'String', default: 'medium' },
          { name: 'assignee', type: 'String', optional: true },
        ],
      },
      {
        name: 'Comment',
        fields: [
          { name: 'taskId', type: 'String' },
          { name: 'author', type: 'String' },
          { name: 'text', type: 'String' },
        ],
      },
    ])
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('full CRUD lifecycle for tasks', async () => {
    // Create
    const task = await apiRequest(runtime, 'POST', '/api/tasks', {
      title: 'Implement API layer',
      description: 'Build the managed API runtime',
      priority: 'high',
      assignee: 'russell',
    })
    expect(task.ok).toBe(true)
    expect(task.item.status).toBe('todo')

    // Update status (simulates "Move to In Progress" button)
    const updated = await apiRequest(runtime, 'PATCH', `/api/tasks/${task.item.id}`, {
      status: 'in_progress',
    })
    expect(updated.item.status).toBe('in_progress')

    // Add comment
    const comment = await apiRequest(runtime, 'POST', '/api/comments', {
      taskId: task.item.id,
      author: 'russell',
      text: 'Starting work on this now',
    })
    expect(comment.ok).toBe(true)

    // List comments for this task
    const comments = await apiRequest(runtime, 'GET', `/api/comments?taskId=${task.item.id}`)
    expect(comments.items.length).toBe(1)

    // Complete the task
    await apiRequest(runtime, 'PATCH', `/api/tasks/${task.item.id}`, { status: 'done' })

    // Verify final state
    const finalTask = await apiRequest(runtime, 'GET', `/api/tasks/${task.item.id}`)
    expect(finalTask.item.status).toBe('done')

    // Delete
    const deleteRes = await apiRequest(runtime, 'DELETE', `/api/tasks/${task.item.id}`)
    expect(deleteRes.ok).toBe(true)

    const remaining = await apiRequest(runtime, 'GET', '/api/tasks')
    expect(remaining.items.length).toBe(0)
  })

  test('kanban-style filtered queries by status', async () => {
    runtime.seed('Task', [
      { title: 'Task A', status: 'todo' },
      { title: 'Task B', status: 'todo' },
      { title: 'Task C', status: 'in_progress' },
      { title: 'Task D', status: 'done' },
      { title: 'Task E', status: 'done' },
      { title: 'Task F', status: 'done' },
    ])

    const todo = await apiRequest(runtime, 'GET', '/api/tasks?status=todo')
    expect(todo.items.length).toBe(2)

    const inProgress = await apiRequest(runtime, 'GET', '/api/tasks?status=in_progress')
    expect(inProgress.items.length).toBe(1)

    const done = await apiRequest(runtime, 'GET', '/api/tasks?status=done')
    expect(done.items.length).toBe(3)
  })
})

// ============================================================================
// 6. Use Case: Feedback Analyzer
// ============================================================================

describe('Use Case: Feedback Analyzer', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'feedback', workDir: TEST_DIR })
    runtime.applySchema([
      {
        name: 'Feedback',
        fields: [
          { name: 'source', type: 'String' },
          { name: 'text', type: 'String' },
          { name: 'sentiment', type: 'String', optional: true },
          { name: 'category', type: 'String', optional: true },
          { name: 'score', type: 'Float', optional: true },
        ],
      },
    ])
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('bulk ingest and analyze feedback', async () => {
    // Simulate agent ingesting feedback from external source
    runtime.seed('Feedback', [
      { source: 'zendesk', text: 'Great product, love it!', sentiment: 'positive', category: 'praise', score: 0.95 },
      { source: 'zendesk', text: 'Login is broken', sentiment: 'negative', category: 'bug', score: 0.15 },
      { source: 'intercom', text: 'Could use a dark mode', sentiment: 'neutral', category: 'feature_request', score: 0.55 },
      { source: 'zendesk', text: 'Amazing support team', sentiment: 'positive', category: 'praise', score: 0.90 },
      { source: 'email', text: 'Performance is terrible', sentiment: 'negative', category: 'bug', score: 0.10 },
    ])

    // Query all feedback
    const all = await apiRequest(runtime, 'GET', '/api/feedbacks')
    expect(all.items.length).toBe(5)

    // Filter by category
    const bugs = await apiRequest(runtime, 'GET', '/api/feedbacks?category=bug')
    expect(bugs.items.length).toBe(2)

    // Filter by sentiment
    const positive = await apiRequest(runtime, 'GET', '/api/feedbacks?sentiment=positive')
    expect(positive.items.length).toBe(2)

    // Filter by source
    const zendesk = await apiRequest(runtime, 'GET', '/api/feedbacks?source=zendesk')
    expect(zendesk.items.length).toBe(3)

    // Simulate agent updating sentiment after re-analysis
    const firstItem = all.items[0] as { id: string }
    const updated = await apiRequest(runtime, 'PATCH', `/api/feedbacks/${firstItem.id}`, {
      sentiment: 'very_positive',
      score: 0.99,
    })
    expect(updated.item.sentiment).toBe('very_positive')
    expect(updated.item.score).toBe(0.99)
  })
})

// ============================================================================
// 7. Field Types
// ============================================================================

describe('ManagedApiRuntime: Field Types', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'types', workDir: TEST_DIR })
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('handles all field types correctly', async () => {
    runtime.applySchema([
      {
        name: 'TypeTest',
        fields: [
          { name: 'textField', type: 'String' },
          { name: 'intField', type: 'Int' },
          { name: 'floatField', type: 'Float' },
          { name: 'boolField', type: 'Boolean' },
          { name: 'dateField', type: 'DateTime' },
          { name: 'jsonField', type: 'Json', optional: true },
        ],
      },
    ])

    const created = await apiRequest(runtime, 'POST', '/api/type-tests', {
      textField: 'hello',
      intField: 42,
      floatField: 3.14,
      boolField: true,
      dateField: '2026-02-20T12:00:00Z',
      jsonField: { nested: { value: true }, array: [1, 2, 3] },
    })

    expect(created.ok).toBe(true)
    expect(created.item.textField).toBe('hello')
    expect(created.item.intField).toBe(42)
    expect(created.item.floatField).toBe(3.14)
    expect(created.item.boolField).toBe(true)
    expect(created.item.dateField).toBe('2026-02-20T12:00:00Z')
    expect(created.item.jsonField).toEqual({ nested: { value: true }, array: [1, 2, 3] })
  })

  test('handles optional fields with defaults', async () => {
    runtime.applySchema([
      {
        name: 'Config',
        fields: [
          { name: 'key', type: 'String' },
          { name: 'value', type: 'String', default: 'default_val' },
          { name: 'enabled', type: 'Boolean', default: true },
          { name: 'count', type: 'Int', default: 0 },
        ],
      },
    ])

    const created = await apiRequest(runtime, 'POST', '/api/configs', { key: 'test' })
    expect(created.ok).toBe(true)
    expect(created.item.key).toBe('test')
    // SQLite defaults applied
    expect(created.item.enabled).toBe(true)
    expect(created.item.count).toBe(0)
  })
})

// ============================================================================
// 8. Mutation Actions via DynamicAppManager.deliverAction
// ============================================================================

describe('DynamicAppManager: Mutation Actions', () => {
  let manager: DynamicAppManager
  const MUT_PERSIST = `${TEST_DIR}/mut-state.json`

  beforeEach(() => {
    cleanup()
    manager = new DynamicAppManager(MUT_PERSIST)
    manager.createSurface('mut_app', 'Mutation Test App')
    manager.applyApiSchema('mut_app', [
      {
        name: 'Todo',
        fields: [
          { name: 'title', type: 'String' },
          { name: 'done', type: 'Boolean', default: false },
        ],
      },
    ])
    manager.seedApiData('mut_app', 'Todo', [
      { title: 'Existing task', done: false },
    ])
  })

  afterEach(() => {
    manager.clear()
  })

  test('deliverAction with _mutation creates a record via POST', async () => {
    const sse = collectSSE(manager)

    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'add_todo',
      context: {
        _mutation: {
          endpoint: '/api/todos',
          method: 'POST',
          body: { title: 'New from mutation', done: false },
        },
      },
      timestamp: new Date().toISOString(),
    })

    // Wait for the async mutation to complete
    await new Promise((r) => setTimeout(r, 100))

    // Verify the record was created
    const query = manager.queryApiData('mut_app', 'Todo')
    expect(query.ok).toBe(true)
    expect((query as any).count).toBe(2)
    const titles = ((query as any).items as any[]).map((i) => i.title)
    expect(titles).toContain('New from mutation')

    // Verify updateData SSE was broadcast
    const updateMsgs = sse.filter((m) => m.type === 'updateData')
    expect(updateMsgs.length).toBeGreaterThanOrEqual(1)
  })

  test('deliverAction with _mutation deletes a record via DELETE', async () => {
    // Get the existing record's id
    const query = manager.queryApiData('mut_app', 'Todo')
    const existingId = ((query as any).items as any[])[0].id

    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'delete_todo',
      context: {
        _mutation: {
          endpoint: `/api/todos/${existingId}`,
          method: 'DELETE',
        },
      },
      timestamp: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 100))

    const afterDelete = manager.queryApiData('mut_app', 'Todo')
    expect(afterDelete.ok).toBe(true)
    expect((afterDelete as any).count).toBe(0)
  })

  test('deliverAction with _mutation updates a record via PATCH', async () => {
    const query = manager.queryApiData('mut_app', 'Todo')
    const existingId = ((query as any).items as any[])[0].id

    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'complete_todo',
      context: {
        _mutation: {
          endpoint: `/api/todos/${existingId}`,
          method: 'PATCH',
          body: { done: true },
        },
      },
      timestamp: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 100))

    const afterUpdate = manager.queryApiData('mut_app', 'Todo')
    expect(afterUpdate.ok).toBe(true)
    const item = ((afterUpdate as any).items as any[])[0]
    expect(item.done).toBe(true)
    expect(item.title).toBe('Existing task')
  })

  test('mutation action does NOT queue for agent (no canvas_action_wait)', async () => {
    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'mutation_action',
      context: {
        _mutation: {
          endpoint: '/api/todos',
          method: 'POST',
          body: { title: 'Should not queue' },
        },
      },
      timestamp: new Date().toISOString(),
    })

    // Attempt to wait for the action — it should NOT have been queued
    const event = await manager.waitForAction('mut_app', 'mutation_action', 50)
    expect(event).toBeNull()
  })

  test('non-mutation action still queues for agent', async () => {
    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'normal_action',
      context: { someData: 'value' },
      timestamp: new Date().toISOString(),
    })

    const event = await manager.waitForAction('mut_app', 'normal_action', 200)
    expect(event).not.toBeNull()
    expect(event!.name).toBe('normal_action')
    expect(event!.context?.someData).toBe('value')
  })

  test('full cycle: create via mutation, verify via query', async () => {
    const sse = collectSSE(manager)

    // Create three items via mutations
    for (let i = 0; i < 3; i++) {
      manager.deliverAction({
        surfaceId: 'mut_app',
        name: 'add_todo',
        context: {
          _mutation: {
            endpoint: '/api/todos',
            method: 'POST',
            body: { title: `Mutation item ${i}`, done: false },
          },
        },
        timestamp: new Date().toISOString(),
      })
    }

    await new Promise((r) => setTimeout(r, 200))

    // Should have 4 items total (1 seed + 3 mutations)
    const query = manager.queryApiData('mut_app', 'Todo')
    expect(query.ok).toBe(true)
    expect((query as any).count).toBe(4)

    // Delete one via mutation
    const items = (query as any).items as any[]
    const targetId = items.find((i: any) => i.title === 'Mutation item 1')?.id
    expect(targetId).toBeDefined()

    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'delete_todo',
      context: {
        _mutation: {
          endpoint: `/api/todos/${targetId}`,
          method: 'DELETE',
        },
      },
      timestamp: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 100))

    const afterDelete = manager.queryApiData('mut_app', 'Todo')
    expect((afterDelete as any).count).toBe(3)
    const titles = ((afterDelete as any).items as any[]).map((i) => i.title)
    expect(titles).not.toContain('Mutation item 1')

    // Verify SSE broadcast occurred (configureApi re-broadcasts + updateData)
    const configMsgs = sse.filter((m) => m.type === 'configureApi')
    expect(configMsgs.length).toBeGreaterThanOrEqual(1)
  })

  test('mutation updates surface.dataModel (not just SSE broadcast)', async () => {
    // First populate the data model via queryApiData with dataPath
    manager.queryApiData('mut_app', 'Todo', undefined, '/todos')
    const surface = manager.getSurface('mut_app')!
    const initialTodos = surface.dataModel.todos as any[]
    expect(initialTodos).toHaveLength(1)
    expect(initialTodos[0].title).toBe('Existing task')

    // POST mutation: add a new todo
    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'add_todo',
      context: {
        _mutation: {
          endpoint: '/api/todos',
          method: 'POST',
          body: { title: 'Added via mutation', done: false },
        },
      },
      timestamp: new Date().toISOString(),
    })
    await new Promise((r) => setTimeout(r, 100))

    // The surface data model should be updated in-memory (not just via SSE)
    const afterAdd = surface.dataModel.todos as any[]
    expect(afterAdd).toHaveLength(2)
    expect(afterAdd.map((t: any) => t.title)).toContain('Added via mutation')

    // DELETE mutation: remove the original task
    const originalId = afterAdd.find((t: any) => t.title === 'Existing task')?.id
    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'delete_todo',
      context: {
        _mutation: {
          endpoint: `/api/todos/${originalId}`,
          method: 'DELETE',
        },
      },
      timestamp: new Date().toISOString(),
    })
    await new Promise((r) => setTimeout(r, 100))

    const afterDelete = surface.dataModel.todos as any[]
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].title).toBe('Added via mutation')

    // PATCH mutation: mark the remaining task as done
    const remainingId = afterDelete[0].id
    manager.deliverAction({
      surfaceId: 'mut_app',
      name: 'complete_todo',
      context: {
        _mutation: {
          endpoint: `/api/todos/${remainingId}`,
          method: 'PATCH',
          body: { done: true },
        },
      },
      timestamp: new Date().toISOString(),
    })
    await new Promise((r) => setTimeout(r, 100))

    const afterPatch = surface.dataModel.todos as any[]
    expect(afterPatch).toHaveLength(1)
    expect(afterPatch[0].done).toBe(true)
    expect(afterPatch[0].title).toBe('Added via mutation')
  })
})

// =============================================================================
// Persistence Round-Trip
// =============================================================================

describe('DynamicAppManager: Persistence', () => {
  const PERSIST_PATH = `${TEST_DIR}/persist-state.json`

  beforeEach(() => {
    cleanup()
  })

  test('surfaces and API runtimes survive manager recreation (simulates restart)', () => {
    // --- Phase 1: Create manager, build surfaces, seed data ---
    const mgr1 = new DynamicAppManager(PERSIST_PATH)
    mgr1.createSurface('dashboard', 'My Dashboard')
    mgr1.applyApiSchema('dashboard', [
      {
        name: 'Metric',
        fields: [
          { name: 'name', type: 'String' },
          { name: 'value', type: 'Float' },
        ],
      },
    ])
    mgr1.seedApiData('dashboard', 'Metric', [
      { name: 'Revenue', value: 42000 },
      { name: 'Users', value: 1500 },
    ])
    mgr1.queryApiData('dashboard', 'Metric', undefined, '/metrics')
    mgr1.updateComponents('dashboard', [
      { id: 'root', component: 'Column', children: ['card'] },
      { id: 'card', component: 'Card', title: 'Dashboard' },
    ])

    // Verify initial state
    const surface1 = mgr1.getSurface('dashboard')!
    expect(surface1.apiModels).toHaveLength(1)
    expect(surface1.apiModels![0].name).toBe('Metric')
    expect((surface1.dataModel.metrics as any[]).length).toBe(2)

    const runtime1 = mgr1.getRuntime('dashboard')
    expect(runtime1).toBeDefined()
    expect(runtime1!.isReady()).toBe(true)

    // Force save (bypass debounce)
    // @ts-expect-error accessing private method
    mgr1.saveToDisk()

    // Destroy the first manager (simulates process exit)
    mgr1.clear()

    // --- Phase 2: Create a NEW manager from the same persist path ---
    const mgr2 = new DynamicAppManager(PERSIST_PATH)

    // Surface should be restored
    const surface2 = mgr2.getSurface('dashboard')!
    expect(surface2).toBeDefined()
    expect(surface2.title).toBe('My Dashboard')
    expect(surface2.components.has('root')).toBe(true)
    expect(surface2.components.has('card')).toBe(true)

    // Data model should be restored
    const metrics = surface2.dataModel.metrics as any[]
    expect(metrics).toHaveLength(2)
    expect(metrics.map((m: any) => m.name).sort()).toEqual(['Revenue', 'Users'])

    // API models should be persisted
    expect(surface2.apiModels).toHaveLength(1)
    expect(surface2.apiModels![0].name).toBe('Metric')

    // Runtime should be auto-restored and ready
    const runtime2 = mgr2.getRuntime('dashboard')
    expect(runtime2).toBeDefined()
    expect(runtime2!.isReady()).toBe(true)

    // Data in the SQLite DB should survive (same DB file on disk)
    const query = mgr2.queryApiData('dashboard', 'Metric')
    expect(query.ok).toBe(true)
    expect((query as any).count).toBe(2)
    const names = ((query as any).items as any[]).map((i: any) => i.name).sort()
    expect(names).toEqual(['Revenue', 'Users'])

    // Mutations should work on the restored runtime
    mgr2.seedApiData('dashboard', 'Metric', [{ name: 'DAU', value: 300 }])
    const afterSeed = mgr2.queryApiData('dashboard', 'Metric')
    expect((afterSeed as any).count).toBe(3)

    mgr2.clear()
  })

  test('reloadFromDisk replaces state from disk', () => {
    // Create initial manager with data
    const mgr = new DynamicAppManager(PERSIST_PATH)
    mgr.createSurface('app1', 'App One')
    mgr.applyApiSchema('app1', [
      { name: 'Item', fields: [{ name: 'label', type: 'String' }] },
    ])
    mgr.seedApiData('app1', 'Item', [{ label: 'Alpha' }, { label: 'Beta' }])
    // @ts-expect-error accessing private method
    mgr.saveToDisk()

    // Mutate in-memory state (simulates stale state before S3 sync)
    mgr.createSurface('app2', 'App Two')
    expect(mgr.listSurfaces()).toContain('app2')

    // Reload from disk should discard in-memory changes
    mgr.reloadFromDisk()

    expect(mgr.listSurfaces()).toEqual(['app1'])
    expect(mgr.getSurface('app2')).toBeUndefined()

    // Runtime should be restored
    const runtime = mgr.getRuntime('app1')
    expect(runtime).toBeDefined()
    expect(runtime!.isReady()).toBe(true)

    const query = mgr.queryApiData('app1', 'Item')
    expect((query as any).count).toBe(2)

    mgr.clear()
  })

  test('surfaces without apiModels do not create runtimes on load', () => {
    const mgr1 = new DynamicAppManager(PERSIST_PATH)
    mgr1.createSurface('simple', 'Simple UI')
    mgr1.updateComponents('simple', [
      { id: 'root', component: 'Text', text: 'Hello' },
    ])
    // @ts-expect-error accessing private method
    mgr1.saveToDisk()
    mgr1.clear()

    const mgr2 = new DynamicAppManager(PERSIST_PATH)
    expect(mgr2.getSurface('simple')).toBeDefined()
    expect(mgr2.getRuntime('simple')).toBeUndefined()

    mgr2.clear()
  })

  test('deleteSurface removes apiModels from persisted state', () => {
    const mgr1 = new DynamicAppManager(PERSIST_PATH)
    mgr1.createSurface('temp', 'Temp')
    mgr1.applyApiSchema('temp', [
      { name: 'Log', fields: [{ name: 'msg', type: 'String' }] },
    ])
    // @ts-expect-error accessing private method
    mgr1.saveToDisk()

    // Verify it's persisted
    const mgr2 = new DynamicAppManager(PERSIST_PATH)
    expect(mgr2.getRuntime('temp')?.isReady()).toBe(true)
    mgr2.clear()

    // Delete and re-save
    mgr1.deleteSurface('temp')
    // @ts-expect-error accessing private method
    mgr1.saveToDisk()
    mgr1.clear()

    // Should not exist after reload
    const mgr3 = new DynamicAppManager(PERSIST_PATH)
    expect(mgr3.getSurface('temp')).toBeUndefined()
    expect(mgr3.getRuntime('temp')).toBeUndefined()
    mgr3.clear()
  })
})
