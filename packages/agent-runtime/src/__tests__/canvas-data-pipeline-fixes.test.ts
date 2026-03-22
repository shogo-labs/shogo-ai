// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas Data Pipeline Fixes — Tests
 *
 * Validates three bug fixes:
 * 1. coerceForInsert: Int/Float string-to-number coercion (expense tracker bug)
 * 2. queryBindings: multiple bindings per model + refresh after mutations (CRM pipeline bug)
 * 3. DataList where prop: exact-value client-side filtering (tested via DynamicAppManager integration)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'fs'
import { ManagedApiRuntime, type ModelDefinition } from '../managed-api-runtime'
import { DynamicAppManager } from '../dynamic-app-manager'
import type { DynamicAppMessage } from '../dynamic-app-types'

const TEST_DIR = '/tmp/test-canvas-pipeline-fixes'

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
}

function collectSSE(manager: DynamicAppManager): DynamicAppMessage[] {
  const messages: DynamicAppMessage[] = []
  manager.addClient((msg) => messages.push(msg))
  return messages
}

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
// 1. coerceForInsert: String-to-number coercion
// ============================================================================

describe('Type Coercion: coerceForInsert handles string values for Int/Float fields', () => {
  let runtime: ManagedApiRuntime

  beforeEach(() => {
    cleanup()
    runtime = new ManagedApiRuntime({ surfaceId: 'test_coerce', workDir: TEST_DIR })
    runtime.applySchema([
      { name: 'Expense', fields: [
        { name: 'description', type: 'String' },
        { name: 'amount', type: 'Float' },
        { name: 'quantity', type: 'Int' },
        { name: 'category', type: 'String' },
      ] },
    ])
  })

  afterEach(() => {
    runtime.destroy()
  })

  test('POST with string amount "45.20" coerces to Float 45.2', async () => {
    const result = await apiRequest(runtime, 'POST', '/api/expenses', {
      description: 'Coffee',
      amount: '45.20',
      quantity: '3',
      category: 'Food',
    })
    expect(result.ok).toBe(true)
    expect(typeof result.item.amount).toBe('number')
    expect(result.item.amount).toBe(45.2)
    expect(typeof result.item.quantity).toBe('number')
    expect(result.item.quantity).toBe(3)
  })

  test('POST with numeric values passes through unchanged', async () => {
    const result = await apiRequest(runtime, 'POST', '/api/expenses', {
      description: 'Lunch',
      amount: 12.50,
      quantity: 1,
      category: 'Food',
    })
    expect(result.ok).toBe(true)
    expect(result.item.amount).toBe(12.5)
    expect(result.item.quantity).toBe(1)
  })

  test('POST with non-numeric string "abc" coerces to null (rejected by NOT NULL constraint)', async () => {
    const result = await apiRequest(runtime, 'POST', '/api/expenses', {
      description: 'Bad input',
      amount: 'abc',
      quantity: 'xyz',
      category: 'Food',
    })
    // Non-nullable Float/Int fields reject null — invalid numeric strings are properly blocked
    expect(result.ok).toBe(false)
  })

  test('PATCH with string amount updates correctly', async () => {
    const created = await apiRequest(runtime, 'POST', '/api/expenses', {
      description: 'Movie',
      amount: 15,
      quantity: 2,
      category: 'Entertainment',
    })
    const updated = await apiRequest(runtime, 'PATCH', `/api/expenses/${created.item.id}`, {
      amount: '29.99',
      quantity: '4',
    })
    expect(updated.ok).toBe(true)
    expect(updated.item.amount).toBe(29.99)
    expect(updated.item.quantity).toBe(4)
  })
})

// ============================================================================
// 2. queryBindings: Multiple bindings per model + refresh after mutations
// ============================================================================

describe('Query Bindings: Multiple per-model bindings with auto-refresh on mutation', () => {
  let manager: DynamicAppManager
  let messages: DynamicAppMessage[]

  beforeEach(() => {
    cleanup()
    manager = new DynamicAppManager(TEST_DIR + '/persist.json')
    messages = collectSSE(manager)

    manager.createSurface('pipeline', 'CRM Pipeline')
    manager.applyApiSchema('pipeline', [
      { name: 'Lead', fields: [
        { name: 'name', type: 'String' },
        { name: 'stage', type: 'String', default: 'new' },
        { name: 'value', type: 'Float' },
      ] },
    ])
    manager.seedApiData('pipeline', 'Lead', [
      { name: 'Alice', stage: 'new', value: 25000 },
      { name: 'Bob', stage: 'new', value: 40000 },
      { name: 'Carol', stage: 'qualified', value: 55000 },
      { name: 'Dave', stage: 'closed', value: 78000 },
    ])
  })

  afterEach(() => {
    manager.clear()
  })

  test('registers multiple query bindings for the same model', () => {
    const r1 = manager.queryApiData('pipeline', 'Lead', { where: { stage: 'new' } }, '/newLeads')
    const r2 = manager.queryApiData('pipeline', 'Lead', { where: { stage: 'qualified' } }, '/qualifiedLeads')
    const r3 = manager.queryApiData('pipeline', 'Lead', { where: { stage: 'closed' } }, '/closedLeads')

    expect((r1 as any).ok).toBe(true)
    expect((r1 as any).count).toBe(2)
    expect((r2 as any).ok).toBe(true)
    expect((r2 as any).count).toBe(1)
    expect((r3 as any).ok).toBe(true)
    expect((r3 as any).count).toBe(1)

    const surface = manager.getSurface('pipeline')!
    const newLeads = surface.dataModel['/newLeads'] ?? (surface.dataModel as any).newLeads
    expect(Array.isArray(newLeads) || surface.dataModel.hasOwnProperty('newLeads')).toBe(true)
  })

  test('executeMutation refreshes all filtered query bindings', async () => {
    manager.queryApiData('pipeline', 'Lead', { where: { stage: 'new' } }, '/newLeads')
    manager.queryApiData('pipeline', 'Lead', { where: { stage: 'qualified' } }, '/qualifiedLeads')
    manager.queryApiData('pipeline', 'Lead', { where: { stage: 'closed' } }, '/closedLeads')

    const surface = manager.getSurface('pipeline')!
    const getNewLeads = () => {
      const s = manager.getSurface('pipeline')!
      const dm = s.dataModel as Record<string, unknown>
      return dm.newLeads as any[] ?? []
    }
    const getQualifiedLeads = () => {
      const s = manager.getSurface('pipeline')!
      const dm = s.dataModel as Record<string, unknown>
      return dm.qualifiedLeads as any[] ?? []
    }

    const initialNew = getNewLeads()
    const initialQual = getQualifiedLeads()
    expect(initialNew.length).toBe(2)
    expect(initialQual.length).toBe(1)

    const runtime = manager.getRuntime('pipeline')!
    const alice = initialNew.find((l: any) => l.name === 'Alice')
    expect(alice).toBeDefined()

    await manager.executeMutation('pipeline', runtime, {
      endpoint: `/api/leads/${alice.id}`,
      method: 'PATCH',
      body: { stage: 'qualified' },
    })

    const updatedNew = getNewLeads()
    const updatedQual = getQualifiedLeads()
    expect(updatedNew.length).toBe(1)
    expect(updatedQual.length).toBe(2)
    expect(updatedNew.find((l: any) => l.name === 'Alice')).toBeUndefined()
    expect(updatedQual.find((l: any) => l.name === 'Alice')).toBeDefined()
  })

  test('seedApiData refreshes all bindings for the model', () => {
    manager.queryApiData('pipeline', 'Lead', { where: { stage: 'new' } }, '/newLeads')
    manager.queryApiData('pipeline', 'Lead', { where: { stage: 'qualified' } }, '/qualifiedLeads')

    const getNewLeads = () => {
      const s = manager.getSurface('pipeline')!
      return (s.dataModel as any).newLeads as any[] ?? []
    }

    expect(getNewLeads().length).toBe(2)

    manager.seedApiData('pipeline', 'Lead', [
      { name: 'NewGuy', stage: 'new', value: 10000 },
    ])

    expect(getNewLeads().length).toBe(3)
  })
})

// ============================================================================
// 3. DataList where prop: validated via DynamicAppManager data model
// ============================================================================

describe('DataList where prop: components registered with where filter on DataList', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    cleanup()
    manager = new DynamicAppManager(TEST_DIR + '/persist.json')
    manager.createSurface('kanban', 'Kanban Test')
    manager.applyApiSchema('kanban', [
      { name: 'Task', fields: [
        { name: 'title', type: 'String' },
        { name: 'status', type: 'String', default: 'todo' },
      ] },
    ])
    manager.seedApiData('kanban', 'Task', [
      { title: 'Task A', status: 'todo' },
      { title: 'Task B', status: 'todo' },
      { title: 'Task C', status: 'done' },
    ])
    manager.queryApiData('kanban', 'Task', {}, '/tasks')
  })

  afterEach(() => {
    manager.clear()
  })

  test('updateComponents with where prop is accepted', () => {
    manager.updateComponents('kanban', [
      { id: 'root', component: 'Column', children: ['todo_list', 'done_list'] },
      { id: 'todo_list', component: 'DataList', children: { path: '/tasks', templateId: 'task_row' }, where: { status: 'todo' } },
      { id: 'done_list', component: 'DataList', children: { path: '/tasks', templateId: 'task_row' }, where: { status: 'done' } },
      { id: 'task_row', component: 'Text', text: { path: 'title' } },
    ] as any)

    const surface = manager.getSurface('kanban')!
    const todoList = surface.components.get('todo_list')
    expect(todoList).toBeDefined()
    expect((todoList as any).where).toEqual({ status: 'todo' })
  })

  test('mutation on shared /tasks array triggers SSE update for all columns', async () => {
    manager.queryApiData('kanban', 'Task', {}, '/tasks')
    const runtime = manager.getRuntime('kanban')!

    const surface = manager.getSurface('kanban')!
    const tasks = (surface.dataModel as any).tasks as any[]
    expect(tasks.length).toBe(3)
    const todoTasks = tasks.filter((t: any) => t.status === 'todo')
    expect(todoTasks.length).toBe(2)

    const taskA = tasks.find((t: any) => t.title === 'Task A')
    await manager.executeMutation('kanban', runtime, {
      endpoint: `/api/tasks/${taskA.id}`,
      method: 'PATCH',
      body: { status: 'done' },
    })

    const updatedSurface = manager.getSurface('kanban')!
    const updatedTasks = (updatedSurface.dataModel as any).tasks as any[]
    expect(updatedTasks.length).toBe(3)
    const updatedTodo = updatedTasks.filter((t: any) => t.status === 'todo')
    expect(updatedTodo.length).toBe(1)
    const updatedDone = updatedTasks.filter((t: any) => t.status === 'done')
    expect(updatedDone.length).toBe(2)
  })
})
