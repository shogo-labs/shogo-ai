// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent Eval Test Cases
 *
 * Tests sub-agent orchestration in both static and dynamic modes.
 * Run with subagentMode: 'static' and subagentMode: 'dynamic' to compare.
 *
 * Categories:
 * - exploration: Can the agent use sub-agents for codebase search?
 * - delegation: Can the agent decompose and delegate multi-step tasks?
 * - cost-awareness: Does the agent pick the cheapest model tier for simple work?
 * - dynamic-creation (dynamic mode only): Can the agent create effective specialists?
 */

import type { AgentEval, EvalResult } from './types'

function toolWasUsed(result: EvalResult, name: string): boolean {
  return result.toolCalls.some(tc => tc.name === name)
}

function toolWasUsedWithArg(result: EvalResult, name: string, key: string, value: string): boolean {
  return result.toolCalls.some(tc =>
    tc.name === name && (tc.input as Record<string, any>)?.[key] === value,
  )
}

function subagentWasSpawned(result: EvalResult): boolean {
  return toolWasUsed(result, 'task') || toolWasUsed(result, 'agent_spawn')
}

function countSubagentSpawns(result: EvalResult): number {
  return result.toolCalls.filter(tc => tc.name === 'task' || tc.name === 'agent_spawn').length
}

// ---------------------------------------------------------------------------
// Large workspace generator — creates 40+ realistic TS stub files
// ---------------------------------------------------------------------------

function generateLargeWorkspace(): Record<string, string> {
  const files: Record<string, string> = {}

  // README
  files['README.md'] = [
    '# Acme Platform',
    '',
    'A full-stack TypeScript platform for managing orders, payments, and notifications.',
    '',
    '## Setup',
    '',
    '```bash',
    'npm install',
    'npm run db:migrate',
    'npm start',
    '```',
    '',
    '## Architecture',
    '',
    '- `src/api/` — Express route handlers',
    '- `src/services/` — Business logic layer',
    '- `src/models/` — Database models and queries',
    '- `src/middleware/` — Express middleware (auth, logging, rate-limit)',
    '- `src/utils/` — Shared utilities',
    '- `src/config/` — Environment and app configuration',
    '- `src/db/` — Database connection and migrations',
    '- `src/workers/` — Background job processors',
    '- `tests/` — Test suites',
  ].join('\n')

  // Config
  files['src/config/env.ts'] = 'export const PORT = parseInt(process.env.PORT || "3000")\nexport const NODE_ENV = process.env.NODE_ENV || "development"\nexport const LOG_LEVEL = process.env.LOG_LEVEL || "info"'
  files['src/config/database.ts'] = 'export const DB_CONFIG = {\n  host: process.env.DB_HOST || "localhost",\n  port: parseInt(process.env.DB_PORT || "5432"),\n  database: process.env.DB_NAME || "acme_dev",\n  ssl: process.env.NODE_ENV === "production",\n}'
  files['src/config/redis.ts'] = 'export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379"\nexport const CACHE_TTL = 3600'
  files['src/config/auth.ts'] = 'export const JWT_SECRET = process.env.JWT_SECRET || "dev-secret"\nexport const JWT_EXPIRY = "24h"\nexport const BCRYPT_ROUNDS = 12'

  // Database
  files['src/db/connection.ts'] = 'import { Pool } from "pg"\nimport { DB_CONFIG } from "../config/database"\nexport const pool = new Pool(DB_CONFIG)\nexport async function query(sql: string, params?: any[]) {\n  const client = await pool.connect()\n  try { return await client.query(sql, params) } finally { client.release() }\n}'
  files['src/db/migrations.ts'] = [
    'import { pool } from "./connection"',
    '',
    'interface Migration { id: string; name: string; up: string; down: string }',
    '',
    'const migrations: Migration[] = [',
    '  { id: "001", name: "create_users", up: "CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW())", down: "DROP TABLE users" },',
    '  { id: "002", name: "create_orders", up: "CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), total INT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW())", down: "DROP TABLE orders" },',
    '  { id: "003", name: "create_payments", up: "CREATE TABLE payments (id SERIAL PRIMARY KEY, order_id INT REFERENCES orders(id), amount INT, provider TEXT, status TEXT DEFAULT \'pending\')", down: "DROP TABLE payments" },',
    '  { id: "004", name: "create_notifications", up: "CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), message TEXT, read BOOLEAN DEFAULT false)", down: "DROP TABLE notifications" },',
    '  { id: "005", name: "add_user_roles", up: "ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'user\'", down: "ALTER TABLE users DROP COLUMN role" },',
    ']',
    '',
    'export async function runMigrations() {',
    '  await pool.query("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())")',
    '  const applied = await pool.query("SELECT id FROM _migrations")',
    '  const appliedIds = new Set(applied.rows.map((r: any) => r.id))',
    '  for (const m of migrations) {',
    '    if (!appliedIds.has(m.id)) {',
    '      await pool.query(m.up)',
    '      await pool.query("INSERT INTO _migrations (id) VALUES ($1)", [m.id])',
    '      console.log(`Applied migration: ${m.name}`)',
    '    }',
    '  }',
    '}',
    '',
    'export async function rollbackMigration(targetId: string) {',
    '  const target = migrations.find(m => m.id === targetId)',
    '  if (!target) throw new Error(`Migration ${targetId} not found`)',
    '  await pool.query(target.down)',
    '  await pool.query("DELETE FROM _migrations WHERE id = $1", [targetId])',
    '}',
    '',
    'export async function getMigrationStatus() {',
    '  const applied = await pool.query("SELECT * FROM _migrations ORDER BY applied_at")',
    '  return { applied: applied.rows, pending: migrations.filter(m => !applied.rows.some((r: any) => r.id === m.id)) }',
    '}',
  ].join('\n')
  files['src/db/seeds.ts'] = [
    'import { pool } from "./connection"',
    '',
    'export async function seedDatabase() {',
    '  await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING", ["admin@acme.com", "$2b$12$fakehash"])',
    '  await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING", ["user@acme.com", "$2b$12$fakehash2"])',
    '  console.log("Database seeded")',
    '}',
  ].join('\n')

  // Auth middleware
  files['src/middleware/auth.ts'] = [
    'import jwt from "jsonwebtoken"',
    'import { JWT_SECRET } from "../config/auth"',
    '',
    'export function authMiddleware(req: any, res: any, next: any) {',
    '  const token = req.headers.authorization?.replace("Bearer ", "")',
    '  if (!token) return res.status(401).json({ error: "Missing token" })',
    '  try {',
    '    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; role: string }',
    '    req.user = decoded',
    '    next()',
    '  } catch {',
    '    res.status(401).json({ error: "Invalid token" })',
    '  }',
    '}',
  ].join('\n')
  files['src/middleware/rate-limit.ts'] = 'const requests = new Map<string, number[]>()\n\nexport function rateLimitMiddleware(limit = 100, windowMs = 60000) {\n  return (req: any, res: any, next: any) => {\n    const ip = req.ip\n    const now = Date.now()\n    const hits = (requests.get(ip) || []).filter(t => t > now - windowMs)\n    if (hits.length >= limit) return res.status(429).json({ error: "Too many requests" })\n    hits.push(now)\n    requests.set(ip, hits)\n    next()\n  }\n}'
  files['src/middleware/logging.ts'] = 'export function loggingMiddleware(req: any, _res: any, next: any) {\n  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)\n  next()\n}'
  files['src/middleware/cors.ts'] = 'export function corsMiddleware(_req: any, res: any, next: any) {\n  res.setHeader("Access-Control-Allow-Origin", "*")\n  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE")\n  next()\n}'
  files['src/middleware/validation.ts'] = 'export function validateBody(schema: Record<string, string>) {\n  return (req: any, res: any, next: any) => {\n    for (const [key, type] of Object.entries(schema)) {\n      if (typeof req.body[key] !== type) return res.status(400).json({ error: `Invalid ${key}` })\n    }\n    next()\n  }\n}'

  // Auth service
  files['src/services/auth.ts'] = [
    'import bcrypt from "bcrypt"',
    'import jwt from "jsonwebtoken"',
    'import { JWT_SECRET, JWT_EXPIRY, BCRYPT_ROUNDS } from "../config/auth"',
    'import { pool } from "../db/connection"',
    '',
    'export async function login(email: string, password: string) {',
    '  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email])',
    '  const user = result.rows[0]',
    '  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new Error("Invalid credentials")',
    '  return jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY })',
    '}',
    '',
    'export async function register(email: string, password: string) {',
    '  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)',
    '  const result = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email", [email, hash])',
    '  return result.rows[0]',
    '}',
  ].join('\n')

  // Models
  files['src/models/user.ts'] = 'import { query } from "../db/connection"\n\nexport async function findUserById(id: number) {\n  const r = await query("SELECT id, email, role, created_at FROM users WHERE id = $1", [id])\n  return r.rows[0] || null\n}\n\nexport async function findUserByEmail(email: string) {\n  const r = await query("SELECT * FROM users WHERE email = $1", [email])\n  return r.rows[0] || null\n}\n\nexport async function listUsers(limit = 50, offset = 0) {\n  const r = await query("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2", [limit, offset])\n  return r.rows\n}'
  files['src/models/order.ts'] = 'import { query } from "../db/connection"\n\nexport async function createOrder(userId: number, total: number) {\n  const r = await query("INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING *", [userId, total])\n  return r.rows[0]\n}\n\nexport async function getOrdersByUser(userId: number) {\n  const r = await query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [userId])\n  return r.rows\n}\n\nexport async function updateOrderStatus(id: number, status: string) {\n  await query("UPDATE orders SET status = $1 WHERE id = $2", [status, id])\n}'
  files['src/models/payment.ts'] = 'import { query } from "../db/connection"\n\nexport async function createPayment(orderId: number, amount: number, provider: string) {\n  const r = await query("INSERT INTO payments (order_id, amount, provider) VALUES ($1, $2, $3) RETURNING *", [orderId, amount, provider])\n  return r.rows[0]\n}\n\nexport async function getPaymentByOrder(orderId: number) {\n  const r = await query("SELECT * FROM payments WHERE order_id = $1", [orderId])\n  return r.rows[0] || null\n}'
  files['src/models/notification.ts'] = 'import { query } from "../db/connection"\n\nexport async function createNotification(userId: number, message: string) {\n  await query("INSERT INTO notifications (user_id, message) VALUES ($1, $2)", [userId, message])\n}\n\nexport async function getUnreadNotifications(userId: number) {\n  const r = await query("SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY id DESC", [userId])\n  return r.rows\n}\n\nexport async function markAsRead(id: number) {\n  await query("UPDATE notifications SET read = true WHERE id = $1", [id])\n}'

  // Services
  files['src/services/order.ts'] = 'import { createOrder, getOrdersByUser, updateOrderStatus } from "../models/order"\nimport { createNotification } from "../models/notification"\n\nexport async function placeOrder(userId: number, items: { price: number }[]) {\n  const total = items.reduce((sum, i) => sum + i.price, 0)\n  const order = await createOrder(userId, total)\n  await createNotification(userId, `Order #${order.id} placed for $${(total / 100).toFixed(2)}`)\n  return order\n}\n\nexport async function cancelOrder(userId: number, orderId: number) {\n  await updateOrderStatus(orderId, "cancelled")\n  await createNotification(userId, `Order #${orderId} cancelled`)\n}\n\nexport { getOrdersByUser }'
  files['src/services/payment.ts'] = 'import { createPayment, getPaymentByOrder } from "../models/payment"\nimport { updateOrderStatus } from "../models/order"\nimport { createNotification } from "../models/notification"\n\nexport async function processPayment(orderId: number, amount: number, userId: number) {\n  const existing = await getPaymentByOrder(orderId)\n  if (existing) throw new Error("Payment already exists")\n  const payment = await createPayment(orderId, amount, "stripe")\n  await updateOrderStatus(orderId, "paid")\n  await createNotification(userId, `Payment of $${(amount / 100).toFixed(2)} processed`)\n  return payment\n}'
  files['src/services/notification.ts'] = 'import { getUnreadNotifications, markAsRead } from "../models/notification"\n\nexport async function getNotifications(userId: number) { return getUnreadNotifications(userId) }\nexport async function dismissNotification(id: number) { return markAsRead(id) }'

  // API routes
  files['src/api/auth.ts'] = 'import { Router } from "express"\nimport { login, register } from "../services/auth"\n\nconst router = Router()\nrouter.post("/login", async (req, res) => {\n  try { const token = await login(req.body.email, req.body.password); res.json({ token }) }\n  catch { res.status(401).json({ error: "Invalid credentials" }) }\n})\nrouter.post("/register", async (req, res) => {\n  try { const user = await register(req.body.email, req.body.password); res.status(201).json(user) }\n  catch { res.status(400).json({ error: "Registration failed" }) }\n})\nexport default router'
  files['src/api/users.ts'] = 'import { Router } from "express"\nimport { listUsers, findUserById } from "../models/user"\nimport { authMiddleware } from "../middleware/auth"\n\nconst router = Router()\nrouter.use(authMiddleware)\nrouter.get("/", async (_req, res) => { res.json(await listUsers()) })\nrouter.get("/:id", async (req, res) => {\n  const user = await findUserById(parseInt(req.params.id))\n  user ? res.json(user) : res.status(404).json({ error: "Not found" })\n})\nexport default router'
  files['src/api/orders.ts'] = 'import { Router } from "express"\nimport { placeOrder, getOrdersByUser, cancelOrder } from "../services/order"\nimport { authMiddleware } from "../middleware/auth"\n\nconst router = Router()\nrouter.use(authMiddleware)\nrouter.get("/", async (req: any, res) => { res.json(await getOrdersByUser(req.user.userId)) })\nrouter.post("/", async (req: any, res) => {\n  const order = await placeOrder(req.user.userId, req.body.items)\n  res.status(201).json(order)\n})\nrouter.post("/:id/cancel", async (req: any, res) => {\n  await cancelOrder(req.user.userId, parseInt(req.params.id))\n  res.json({ ok: true })\n})\nexport default router'
  files['src/api/payments.ts'] = 'import { Router } from "express"\nimport { processPayment } from "../services/payment"\nimport { authMiddleware } from "../middleware/auth"\n\nconst router = Router()\nrouter.use(authMiddleware)\nrouter.post("/", async (req: any, res) => {\n  try {\n    const payment = await processPayment(req.body.orderId, req.body.amount, req.user.userId)\n    res.status(201).json(payment)\n  } catch (e: any) { res.status(400).json({ error: e.message }) }\n})\nexport default router'
  files['src/api/notifications.ts'] = 'import { Router } from "express"\nimport { getNotifications, dismissNotification } from "../services/notification"\nimport { authMiddleware } from "../middleware/auth"\n\nconst router = Router()\nrouter.use(authMiddleware)\nrouter.get("/", async (req: any, res) => { res.json(await getNotifications(req.user.userId)) })\nrouter.post("/:id/dismiss", async (req, res) => {\n  await dismissNotification(parseInt(req.params.id))\n  res.json({ ok: true })\n})\nexport default router'
  files['src/api/health.ts'] = 'import { Router } from "express"\nimport { pool } from "../db/connection"\n\nconst router = Router()\nrouter.get("/", async (_req, res) => {\n  try { await pool.query("SELECT 1"); res.json({ status: "ok" }) }\n  catch { res.status(500).json({ status: "unhealthy" }) }\n})\nexport default router'
  files['src/api/index.ts'] = 'import { Router } from "express"\nimport authRoutes from "./auth"\nimport userRoutes from "./users"\nimport orderRoutes from "./orders"\nimport paymentRoutes from "./payments"\nimport notificationRoutes from "./notifications"\nimport healthRoutes from "./health"\n\nconst api = Router()\napi.use("/auth", authRoutes)\napi.use("/users", userRoutes)\napi.use("/orders", orderRoutes)\napi.use("/payments", paymentRoutes)\napi.use("/notifications", notificationRoutes)\napi.use("/health", healthRoutes)\nexport default api'

  // Utils
  files['src/utils/logger.ts'] = 'type LogLevel = "debug" | "info" | "warn" | "error"\nconst levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }\n\nexport function createLogger(name: string, minLevel: LogLevel = "info") {\n  return {\n    debug: (msg: string) => levels.debug >= levels[minLevel] && console.log(`[${name}] DEBUG: ${msg}`),\n    info: (msg: string) => levels.info >= levels[minLevel] && console.log(`[${name}] INFO: ${msg}`),\n    warn: (msg: string) => levels.warn >= levels[minLevel] && console.warn(`[${name}] WARN: ${msg}`),\n    error: (msg: string) => levels.error >= levels[minLevel] && console.error(`[${name}] ERROR: ${msg}`),\n  }\n}'
  files['src/utils/hash.ts'] = 'import crypto from "crypto"\n\nexport function sha256(data: string) { return crypto.createHash("sha256").update(data).digest("hex") }\nexport function randomId(len = 16) { return crypto.randomBytes(len).toString("hex") }'
  files['src/utils/date.ts'] = 'export function formatDate(d: Date) { return d.toISOString().split("T")[0] }\nexport function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d }\nexport function isExpired(date: Date) { return date.getTime() < Date.now() }'
  files['src/utils/pagination.ts'] = 'export function parsePagination(query: any) {\n  const page = Math.max(1, parseInt(query.page) || 1)\n  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20))\n  return { limit, offset: (page - 1) * limit }\n}'
  files['src/utils/errors.ts'] = 'export class AppError extends Error {\n  constructor(message: string, public statusCode: number = 500) { super(message); this.name = "AppError" }\n}\nexport class NotFoundError extends AppError {\n  constructor(entity: string) { super(`${entity} not found`, 404) }\n}\nexport class UnauthorizedError extends AppError {\n  constructor() { super("Unauthorized", 401) }\n}'
  files['src/utils/validate.ts'] = 'export function isEmail(s: string) { return /^[^@]+@[^@]+\\.[^@]+$/.test(s) }\nexport function isStrongPassword(s: string) { return s.length >= 8 && /[A-Z]/.test(s) && /[0-9]/.test(s) }'

  // Workers
  files['src/workers/email.ts'] = 'import { createLogger } from "../utils/logger"\nconst log = createLogger("email-worker")\n\nexport async function processEmailQueue() {\n  log.info("Processing email queue...")\n  // In production this would poll Redis/SQS\n}\n\nexport async function sendEmail(to: string, subject: string, body: string) {\n  log.info(`Sending email to ${to}: ${subject}`)\n  // Mock: would call SendGrid/SES\n}'
  files['src/workers/cleanup.ts'] = 'import { pool } from "../db/connection"\nimport { createLogger } from "../utils/logger"\nconst log = createLogger("cleanup-worker")\n\nexport async function cleanupExpiredSessions() {\n  log.info("Cleaning up expired sessions...")\n  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()")\n}'

  // App entry
  files['src/app.ts'] = 'import express from "express"\nimport api from "./api"\nimport { loggingMiddleware } from "./middleware/logging"\nimport { corsMiddleware } from "./middleware/cors"\nimport { rateLimitMiddleware } from "./middleware/rate-limit"\n\nexport const app = express()\napp.use(express.json())\napp.use(corsMiddleware)\napp.use(loggingMiddleware)\napp.use(rateLimitMiddleware())\napp.use("/api", api)'
  files['src/index.ts'] = 'import { app } from "./app"\nimport { PORT } from "./config/env"\nimport { runMigrations } from "./db/migrations"\nimport { createLogger } from "./utils/logger"\n\nconst log = createLogger("server")\n\nasync function start() {\n  await runMigrations()\n  app.listen(PORT, () => log.info(`Server running on port ${PORT}`))\n}\n\nstart().catch(e => { log.error(e.message); process.exit(1) })'

  // Tests
  files['tests/auth.test.ts'] = 'import { describe, it, expect } from "vitest"\n\ndescribe("auth", () => {\n  it("should hash passwords", () => { expect(true).toBe(true) })\n  it("should verify JWT tokens", () => { expect(true).toBe(true) })\n  it("should reject expired tokens", () => { expect(true).toBe(true) })\n})'
  files['tests/orders.test.ts'] = 'import { describe, it, expect } from "vitest"\n\ndescribe("orders", () => {\n  it("should create an order", () => { expect(true).toBe(true) })\n  it("should cancel an order", () => { expect(true).toBe(true) })\n  it("should list user orders", () => { expect(true).toBe(true) })\n})'
  files['tests/payments.test.ts'] = 'import { describe, it, expect } from "vitest"\n\ndescribe("payments", () => {\n  it("should process a payment", () => { expect(true).toBe(true) })\n  it("should reject duplicate payments", () => { expect(true).toBe(true) })\n})'
  files['tests/api.test.ts'] = 'import { describe, it, expect } from "vitest"\n\ndescribe("API integration", () => {\n  it("should return 200 on health check", () => { expect(true).toBe(true) })\n  it("should return 401 without token", () => { expect(true).toBe(true) })\n  it("should paginate results", () => { expect(true).toBe(true) })\n})'

  // Package/config files
  files['package.json'] = '{ "name": "acme-platform", "version": "1.0.0", "dependencies": { "express": "^4", "pg": "^8", "jsonwebtoken": "^9", "bcrypt": "^5" }, "devDependencies": { "vitest": "^1", "typescript": "^5" }, "scripts": { "start": "tsx src/index.ts", "test": "vitest run", "db:migrate": "tsx src/db/migrations.ts" } }'
  files['tsconfig.json'] = '{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "outDir": "dist", "rootDir": "src" } }'

  return files
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const subagentEvals: AgentEval[] = [
  // =========================================================================
  // E1: Exploration — delegate search to sub-agent
  // =========================================================================
  {
    id: 'subagent-explore-basic',
    name: 'Use explore sub-agent for codebase search',
    category: 'tool-usage',
    level: 2,
    input:
      'This is a large TypeScript project with many files. I need you to find all files ' +
      'that define database migration functions. Search the codebase using a sub-agent.',
    workspaceFiles: generateLargeWorkspace(),
    validationCriteria: [
      {
        id: 'used-subagent',
        description: 'Agent delegated search to a sub-agent instead of searching directly',
        points: 3,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'used-explore-type',
        description: 'Agent used the explore sub-agent type (cheapest for search)',
        points: 2,
        phase: 'intention',
        validate: (r) =>
          toolWasUsedWithArg(r, 'task', 'subagent_type', 'explore') ||
          toolWasUsedWithArg(r, 'agent_spawn', 'type', 'explore'),
      },
      {
        id: 'found-migrations',
        description: 'Response mentions migrations.ts or the migration functions',
        points: 5,
        phase: 'execution',
        validate: (r) =>
          r.responseText.includes('migrations.ts') ||
          r.responseText.includes('runMigrations') ||
          r.responseText.includes('rollbackMigration'),
      },
    ],
    maxScore: 10,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // E2: Delegation — multi-step parallel task decomposition
  // =========================================================================
  {
    id: 'subagent-parallel-search',
    name: 'Spawn parallel sub-agents for independent searches',
    category: 'tool-usage',
    level: 3,
    input:
      'This is a large TypeScript project. I need three independent analyses done in parallel:\n' +
      '(1) How does authentication work? Find all auth-related files and explain the flow.\n' +
      '(2) What database technology is used and how are queries structured?\n' +
      '(3) List all API routes and their HTTP methods.\n' +
      'Search each topic in parallel using sub-agents.',
    workspaceFiles: generateLargeWorkspace(),
    validationCriteria: [
      {
        id: 'multiple-subagents',
        description: 'Agent spawned multiple sub-agents (2+) for the independent searches',
        points: 4,
        phase: 'intention',
        validate: (r) => countSubagentSpawns(r) >= 2,
      },
      {
        id: 'found-auth',
        description: 'Response covers authentication (JWT, middleware, bcrypt)',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          r.responseText.toLowerCase().includes('jwt') ||
          r.responseText.toLowerCase().includes('bcrypt') ||
          (r.responseText.toLowerCase().includes('auth') && r.responseText.toLowerCase().includes('middleware')),
      },
      {
        id: 'found-db',
        description: 'Response covers database (PostgreSQL, pg, Pool)',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          r.responseText.toLowerCase().includes('postgres') ||
          r.responseText.toLowerCase().includes('pool') ||
          r.responseText.includes('pg'),
      },
      {
        id: 'found-api',
        description: 'Response covers API routes (users, orders, payments)',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          (r.responseText.toLowerCase().includes('route') || r.responseText.toLowerCase().includes('/api')) &&
          (r.responseText.toLowerCase().includes('users') || r.responseText.toLowerCase().includes('orders')),
      },
    ],
    maxScore: 13,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // E3: Cost awareness — model tier selection
  // =========================================================================
  {
    id: 'subagent-cost-awareness',
    name: 'Use fast model tier for simple exploration tasks',
    category: 'tool-usage',
    level: 2,
    input:
      'Quickly scan this project to find the README and summarize the setup instructions. ' +
      'Use the cheapest approach possible — delegate to a sub-agent with the fast model tier.',
    workspaceFiles: generateLargeWorkspace(),
    validationCriteria: [
      {
        id: 'used-fast-tier',
        description: 'Agent used a fast/cheap model tier or explore sub-agent type',
        points: 3,
        phase: 'intention',
        validate: (r) =>
          toolWasUsedWithArg(r, 'task', 'model_tier', 'fast') ||
          toolWasUsedWithArg(r, 'task', 'subagent_type', 'explore') ||
          toolWasUsedWithArg(r, 'agent_spawn', 'type', 'explore'),
      },
      {
        id: 'found-readme',
        description: 'Response includes README content (setup instructions)',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          r.responseText.includes('npm install') ||
          r.responseText.includes('db:migrate') ||
          r.responseText.includes('Acme Platform'),
      },
    ],
    maxScore: 7,
    tags: ['static', 'dynamic'],
  },

  // =========================================================================
  // E4 (dynamic mode only): agent creation
  // =========================================================================
  {
    id: 'subagent-dynamic-create',
    name: 'Create and use a custom specialist agent',
    category: 'tool-usage',
    level: 4,
    input: 'I want you to build a specialist that can review TypeScript code for common anti-patterns. Create the specialist, then use it to review the code in src/api/handler.ts.',
    workspaceFiles: {
      ...generateLargeWorkspace(),
      'src/api/handler.ts': [
        'export async function handleRequest(req: any, res: any) {',
        '  try {',
        '    const data = JSON.parse(req.body)',
        '    const result = await fetch("http://external-api.com/data")',
        '    const json = await result.json()',
        '    res.json({ ok: true, data: json })',
        '  } catch (e) {',
        '    console.log(e)',
        '    res.status(500).json({ error: "Something went wrong" })',
        '  }',
        '}',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'created-agent',
        description: 'Agent used agent_create to define a custom review specialist',
        points: 3,
        phase: 'intention',
        validate: (r) => toolWasUsed(r, 'agent_create'),
      },
      {
        id: 'spawned-agent',
        description: 'Agent spawned the custom agent to review the code',
        points: 3,
        phase: 'intention',
        validate: (r) => toolWasUsed(r, 'agent_spawn'),
      },
      {
        id: 'found-issues',
        description: 'Review identified at least one anti-pattern (any type, console.log, untyped catch, etc.)',
        points: 4,
        phase: 'execution',
        validate: (r) =>
          r.responseText.toLowerCase().includes('any') ||
          r.responseText.toLowerCase().includes('console.log') ||
          r.responseText.toLowerCase().includes('error handling') ||
          r.responseText.toLowerCase().includes('anti-pattern'),
      },
    ],
    maxScore: 10,
    tags: ['dynamic'],
  },

  // =========================================================================
  // E4-static: Delegate code review to sub-agent (static mode equivalent)
  // =========================================================================
  {
    id: 'subagent-static-review',
    name: 'Delegate code review to a sub-agent',
    category: 'tool-usage',
    level: 3,
    input:
      'I need a thorough code review of src/api/handler.ts. This file has several anti-patterns. ' +
      'Delegate this review to a sub-agent with a detailed prompt about what to look for ' +
      '(type safety, error handling, logging, hardcoded values).',
    workspaceFiles: {
      ...generateLargeWorkspace(),
      'src/api/handler.ts': [
        'export async function handleRequest(req: any, res: any) {',
        '  try {',
        '    const data = JSON.parse(req.body)',
        '    const result = await fetch("http://external-api.com/data")',
        '    const json = await result.json()',
        '    res.json({ ok: true, data: json })',
        '  } catch (e) {',
        '    console.log(e)',
        '    res.status(500).json({ error: "Something went wrong" })',
        '  }',
        '}',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'used-task-tool',
        description: 'Agent delegated the review to a sub-agent using the task tool',
        points: 4,
        phase: 'intention',
        validate: (r) => subagentWasSpawned(r),
      },
      {
        id: 'found-issues',
        description: 'Review identified at least one anti-pattern (any type, console.log, error handling)',
        points: 5,
        phase: 'execution',
        validate: (r) =>
          r.responseText.toLowerCase().includes('any') ||
          r.responseText.toLowerCase().includes('console.log') ||
          r.responseText.toLowerCase().includes('error handling') ||
          r.responseText.toLowerCase().includes('anti-pattern'),
      },
    ],
    maxScore: 9,
    tags: ['static'],
  },

  // =========================================================================
  // E5: Background execution
  // =========================================================================
  {
    id: 'subagent-background',
    name: 'Use background execution for a long-running task',
    category: 'tool-usage',
    level: 3,
    input:
      'Run a comprehensive security audit of every source file in this project. ' +
      'This is a large codebase so use a background task, then check on its progress.',
    workspaceFiles: generateLargeWorkspace(),
    validationCriteria: [
      {
        id: 'used-background',
        description: 'Agent used background: true parameter',
        points: 4,
        phase: 'intention',
        validate: (r) =>
          r.toolCalls.some(tc =>
            (tc.name === 'task' || tc.name === 'agent_spawn') &&
            (tc.input as any)?.background === true,
          ),
      },
      {
        id: 'checked-status',
        description: 'Agent checked the background task status',
        points: 3,
        phase: 'intention',
        validate: (r) =>
          toolWasUsed(r, 'task_status') || toolWasUsed(r, 'agent_status') || toolWasUsed(r, 'agent_result'),
      },
      {
        id: 'provided-analysis',
        description: 'Response includes some analysis of the codebase',
        points: 3,
        phase: 'execution',
        validate: (r) =>
          r.responseText.length > 200 &&
          (r.responseText.toLowerCase().includes('security') ||
           r.responseText.toLowerCase().includes('audit') ||
           r.responseText.toLowerCase().includes('file')),
      },
    ],
    maxScore: 10,
    tags: ['static', 'dynamic'],
  },
]

export default subagentEvals
