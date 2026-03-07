// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hono Server
 *
 * API server with auto-generated CRUD routes from Prisma schema.
 * Customize this file to add middleware, auth, or custom routes.
 *
 * The SDK generates per-model route files with full CRUD operations.
 * Run `bun run generate` after schema changes to regenerate routes.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

// CORS middleware
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

// Health check endpoint
app.get('/health', (c) => c.json({ ok: true, timestamp: new Date().toISOString() }))

// Mount SDK-generated API routes (CRUD for all Prisma models)
app.route('/api', createAllRoutes(prisma))

// Serve static files in production
app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(`Server running on http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
