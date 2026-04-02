// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent Code Writing Eval Test Cases
 *
 * Tests the agent's ability to decompose coding tasks, delegate work to
 * sub-agents, and assemble correct multi-file output.
 *
 * Run in both subagentMode: 'static' and 'dynamic' for A/B comparison:
 *   bun run src/evals/run-eval.ts --track subagent-code --subagent-mode static
 *   bun run src/evals/run-eval.ts --track subagent-code --subagent-mode dynamic
 */

import type { AgentEval, EvalResult } from './types'

function subagentWasSpawned(r: EvalResult): boolean {
  return r.toolCalls.some(tc =>
    tc.name === 'task' || tc.name === 'agent_spawn',
  )
}

function fileWasWritten(r: EvalResult, pathSubstr: string): boolean {
  return r.toolCalls.some(tc =>
    (tc.name === 'write_file' || tc.name === 'edit_file') &&
    JSON.stringify(tc.input).includes(pathSubstr),
  )
}

function writeContentContains(r: EvalResult, pathSubstr: string, contentSubstr: string): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'write_file' || tc.name === 'edit_file')
    .some(tc => {
      const input = JSON.stringify(tc.input)
      return input.includes(pathSubstr) && input.toLowerCase().includes(contentSubstr.toLowerCase())
    })
}

function countSubagentSpawns(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task' || tc.name === 'agent_spawn').length
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const SUBAGENT_CODE_EVALS: AgentEval[] = [

  // =========================================================================
  // L3: API endpoint with validation
  // =========================================================================
  {
    id: 'subagent-code-api-endpoint',
    name: 'Code: Build REST API endpoint with validation',
    category: 'subagent',
    level: 3,
    input: 'Build a REST API endpoint for user registration at POST /api/register. It should validate that email is a valid email format, password is at least 8 characters, and name is non-empty. Return 400 with specific error messages for invalid input, or 201 with the created user (minus password) on success. Write it in src/api/register.ts.',
    workspaceFiles: {
      'src/app.ts': 'import express from "express"\nexport const app = express()\napp.use(express.json())\n',
      'package.json': '{ "name": "test-api", "dependencies": { "express": "^4.18.0" } }',
    },
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent delegated code writing to a sub-agent',
        points: 3,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'file-written',
        description: 'src/api/register.ts was created',
        points: 3,
        phase: 'execution',
        validate: (r) => fileWasWritten(r, 'register'),
      },
      {
        id: 'has-email-validation',
        description: 'Code includes email validation logic',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'register', 'email') &&
          (writeContentContains(r, 'register', '@') || writeContentContains(r, 'register', 'valid')),
      },
      {
        id: 'has-password-validation',
        description: 'Code includes password length validation',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'register', 'password') &&
          (writeContentContains(r, 'register', 'length') || writeContentContains(r, 'register', '8')),
      },
    ],
    maxScore: 10,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // L4: Multi-file refactor to extract shared module
  // =========================================================================
  {
    id: 'subagent-code-refactor-multifile',
    name: 'Code: Refactor 3 files to extract shared utility',
    category: 'subagent',
    level: 4,
    input: 'These three files all have duplicated date formatting logic. Refactor them to extract the shared formatDate and parseDate functions into a new src/utils/dates.ts module, then update the imports in all three files.',
    workspaceFiles: {
      'src/api/orders.ts': [
        'export function getOrders() {',
        '  const orders = [{ id: 1, date: "2026-01-15" }]',
        '  return orders.map(o => ({',
        '    ...o,',
        '    date: formatDate(o.date),',
        '  }))',
        '}',
        '',
        'function formatDate(dateStr: string): string {',
        '  const d = new Date(dateStr)',
        '  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`',
        '}',
        '',
        'function parseDate(formatted: string): Date {',
        '  const [m, d, y] = formatted.split("/").map(Number)',
        '  return new Date(y, m - 1, d)',
        '}',
      ].join('\n'),
      'src/api/invoices.ts': [
        'export function getInvoices() {',
        '  const invoices = [{ id: 100, dueDate: "2026-02-28" }]',
        '  return invoices.map(inv => ({',
        '    ...inv,',
        '    dueDate: formatDate(inv.dueDate),',
        '  }))',
        '}',
        '',
        'function formatDate(dateStr: string): string {',
        '  const d = new Date(dateStr)',
        '  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`',
        '}',
        '',
        'function parseDate(formatted: string): Date {',
        '  const [m, d, y] = formatted.split("/").map(Number)',
        '  return new Date(y, m - 1, d)',
        '}',
      ].join('\n'),
      'src/reports/summary.ts': [
        'export function generateSummary(startDate: string, endDate: string) {',
        '  return {',
        '    period: `${formatDate(startDate)} - ${formatDate(endDate)}`,',
        '    generated: new Date().toISOString(),',
        '  }',
        '}',
        '',
        'function formatDate(dateStr: string): string {',
        '  const d = new Date(dateStr)',
        '  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`',
        '}',
        '',
        'function parseDate(formatted: string): Date {',
        '  const [m, d, y] = formatted.split("/").map(Number)',
        '  return new Date(y, m - 1, d)',
        '}',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent used sub-agents for analysis or refactoring',
        points: 3,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'shared-module-created',
        description: 'src/utils/dates.ts (or similar shared module) was created',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          fileWasWritten(r, 'utils/date') || fileWasWritten(r, 'shared/date') || fileWasWritten(r, 'utils/format'),
      },
      {
        id: 'exports-formatDate',
        description: 'Shared module exports formatDate',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'utils/', 'export') && writeContentContains(r, 'utils/', 'formatDate'),
      },
      {
        id: 'files-updated',
        description: 'At least 2 of the 3 original files were updated with imports',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const updated = ['orders', 'invoices', 'summary'].filter(f =>
            r.toolCalls.some(tc =>
              (tc.name === 'write_file' || tc.name === 'edit_file') &&
              JSON.stringify(tc.input).includes(f) &&
              JSON.stringify(tc.input).includes('import'),
            ),
          )
          return updated.length >= 2
        },
      },
    ],
    maxScore: 12,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // L3: Test generation for auth module
  // =========================================================================
  {
    id: 'subagent-code-test-generation',
    name: 'Code: Generate unit tests for auth module',
    category: 'subagent',
    level: 3,
    input: 'Write unit tests for the auth module in src/auth.ts. Cover all exported functions: hashPassword, verifyPassword, generateToken, and validateToken. Use any test framework you prefer.',
    workspaceFiles: {
      'src/auth.ts': [
        'import crypto from "crypto"',
        '',
        'const SECRET = process.env.JWT_SECRET || "default-secret"',
        '',
        'export function hashPassword(password: string): string {',
        '  const salt = crypto.randomBytes(16).toString("hex")',
        '  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex")',
        '  return `${salt}:${hash}`',
        '}',
        '',
        'export function verifyPassword(password: string, stored: string): boolean {',
        '  const [salt, hash] = stored.split(":")',
        '  const attempt = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex")',
        '  return hash === attempt',
        '}',
        '',
        'export function generateToken(userId: string, expiresIn = 3600): string {',
        '  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")',
        '  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + expiresIn })).toString("base64url")',
        '  const signature = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url")',
        '  return `${header}.${payload}.${signature}`',
        '}',
        '',
        'export function validateToken(token: string): { valid: boolean; userId?: string } {',
        '  const [header, payload, signature] = token.split(".")',
        '  const expected = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url")',
        '  if (signature !== expected) return { valid: false }',
        '  const data = JSON.parse(Buffer.from(payload, "base64url").toString())',
        '  if (data.exp < Math.floor(Date.now() / 1000)) return { valid: false }',
        '  return { valid: true, userId: data.sub }',
        '}',
      ].join('\n'),
      'package.json': '{ "name": "test-project", "devDependencies": { "vitest": "^1.0.0" } }',
    },
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent used a sub-agent (explore to read, then code agent to write tests)',
        points: 3,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'test-file-created',
        description: 'A test file was created (*.test.ts or *.spec.ts)',
        points: 3,
        phase: 'execution',
        validate: (r) => fileWasWritten(r, '.test.') || fileWasWritten(r, '.spec.'),
      },
      {
        id: 'covers-hash',
        description: 'Tests cover hashPassword',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'test', 'hashPassword') || writeContentContains(r, 'spec', 'hashPassword'),
      },
      {
        id: 'covers-verify',
        description: 'Tests cover verifyPassword',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'test', 'verifyPassword') || writeContentContains(r, 'spec', 'verifyPassword'),
      },
      {
        id: 'covers-token',
        description: 'Tests cover generateToken or validateToken',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          writeContentContains(r, 'test', 'generateToken') || writeContentContains(r, 'test', 'validateToken') ||
          writeContentContains(r, 'spec', 'generateToken') || writeContentContains(r, 'spec', 'validateToken'),
      },
    ],
    maxScore: 12,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // L4: Bug fix pipeline — find and fix
  // =========================================================================
  {
    id: 'subagent-code-bug-fix-pipeline',
    name: 'Code: Find and fix bug in payment processing',
    category: 'subagent',
    level: 4,
    input: 'There\'s a bug in the payment processing code — customers are being charged slightly wrong amounts on orders with discounts. Find the bug and fix it.',
    workspaceFiles: {
      'src/payments/calculate.ts': [
        'export interface LineItem {',
        '  name: string',
        '  price: number  // cents',
        '  quantity: number',
        '}',
        '',
        'export interface Discount {',
        '  type: "percentage" | "fixed"',
        '  value: number  // percentage (0-100) or fixed cents',
        '}',
        '',
        'export function calculateTotal(items: LineItem[], discount?: Discount): number {',
        '  let subtotal = 0',
        '  for (let i = 0; i < items.length; i++) {',
        '    subtotal += items[i].price * items[i].quantity',
        '  }',
        '',
        '  if (discount) {',
        '    if (discount.type === "percentage") {',
        '      // BUG: divides by 10 instead of 100',
        '      subtotal = subtotal - Math.round(subtotal * discount.value / 10)',
        '    } else {',
        '      subtotal = subtotal - discount.value',
        '    }',
        '  }',
        '',
        '  return Math.max(0, subtotal)',
        '}',
      ].join('\n'),
      'src/payments/checkout.ts': [
        'import { calculateTotal, type LineItem, type Discount } from "./calculate"',
        '',
        'export async function processCheckout(items: LineItem[], discount?: Discount) {',
        '  const total = calculateTotal(items, discount)',
        '  // simulate payment',
        '  return { success: true, charged: total, items: items.length }',
        '}',
      ].join('\n'),
      'src/payments/index.ts': 'export { calculateTotal } from "./calculate"\nexport { processCheckout } from "./checkout"\n',
    },
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent used sub-agents to find and/or fix the bug',
        points: 3,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'identified-calculate',
        description: 'Agent identified calculate.ts as the file with the bug',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          r.responseText.includes('calculate') ||
          r.toolCalls.some(tc => JSON.stringify(tc.input).includes('calculate')),
      },
      {
        id: 'fixed-division',
        description: 'The fix changes /10 to /100 in the percentage discount calculation',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          r.toolCalls.some(tc =>
            (tc.name === 'write_file' || tc.name === 'edit_file') &&
            JSON.stringify(tc.input).includes('calculate') &&
            JSON.stringify(tc.input).includes('100'),
          ),
      },
    ],
    maxScore: 10,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // L5: Full-stack feature — search across API + frontend + tests
  // =========================================================================
  {
    id: 'subagent-code-fullstack-feature',
    name: 'Code: Build full-stack search feature (API + UI + tests)',
    category: 'subagent',
    level: 5,
    input: 'Add a product search feature to this app. I need: (1) a GET /api/products/search endpoint that accepts a ?q= query parameter and filters products by name, (2) a React component SearchBar.tsx that calls the endpoint and displays results, and (3) basic tests for the endpoint. Use sub-agents to work on different parts in parallel if possible.',
    workspaceFiles: {
      'src/api/products.ts': [
        'const products = [',
        '  { id: 1, name: "Wireless Keyboard", price: 4999, category: "electronics" },',
        '  { id: 2, name: "USB-C Hub", price: 2999, category: "electronics" },',
        '  { id: 3, name: "Standing Desk", price: 49999, category: "furniture" },',
        '  { id: 4, name: "Monitor Light Bar", price: 3999, category: "electronics" },',
        '  { id: 5, name: "Ergonomic Chair", price: 39999, category: "furniture" },',
        ']',
        '',
        'export function getAllProducts() { return products }',
        'export function getProductById(id: number) { return products.find(p => p.id === id) }',
      ].join('\n'),
      'src/components/ProductList.tsx': [
        'import React from "react"',
        '',
        'export function ProductList({ products }: { products: Array<{ id: number; name: string; price: number }> }) {',
        '  return (',
        '    <ul>',
        '      {products.map(p => <li key={p.id}>{p.name} — ${(p.price/100).toFixed(2)}</li>)}',
        '    </ul>',
        '  )',
        '}',
      ].join('\n'),
      'package.json': '{ "name": "product-app", "dependencies": { "react": "^18", "express": "^4" }, "devDependencies": { "vitest": "^1" } }',
    },
    validationCriteria: [
      {
        id: 'multiple-subagents',
        description: 'Agent spawned 2+ sub-agents for different concerns',
        points: 4,
        phase: 'intention',
        validate: (r) => countSubagentSpawns(r) >= 2,
      },
      {
        id: 'api-created',
        description: 'Search API endpoint file was created',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          fileWasWritten(r, 'search') &&
          r.toolCalls.some(tc =>
            tc.name === 'write_file' &&
            JSON.stringify(tc.input).toLowerCase().includes('query'),
          ),
      },
      {
        id: 'component-created',
        description: 'SearchBar component was created',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          fileWasWritten(r, 'SearchBar') || fileWasWritten(r, 'searchbar') || fileWasWritten(r, 'Search'),
      },
      {
        id: 'tests-created',
        description: 'Test file was created',
        points: 3,
        phase: 'execution',
        validate: (r) => fileWasWritten(r, '.test.') || fileWasWritten(r, '.spec.'),
      },
      {
        id: 'three-files-total',
        description: 'At least 3 files were written/created',
        points: 2,
        phase: 'execution',
        validate: (r) =>
          r.toolCalls.filter(tc => tc.name === 'write_file').length >= 3,
      },
    ],
    maxScore: 15,
    tags: ['static', 'dynamic'],
  },
]

export default SUBAGENT_CODE_EVALS
