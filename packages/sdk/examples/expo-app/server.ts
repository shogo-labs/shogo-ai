// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Expo App Server
 *
 * Hono server that serves:
 * - /api/* - Prisma CRUD routes
 * - /* - Expo static web build
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { createGeneratedRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

// Enable CORS for mobile app requests
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Mount API routes at /api
app.route('/api', createGeneratedRoutes({ prisma }))

// Health check endpoint
app.get('/health', (c) => c.json({ ok: true }))

// Serve static files from dist/ (Expo web build output)
app.use('/*', serveStatic({ root: './dist' }))

// Fallback to index.html for SPA routing
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3000', 10)
console.log(`[expo-app] Server starting on port ${port}...`)

export default {
  port,
  fetch: app.fetch,
}
