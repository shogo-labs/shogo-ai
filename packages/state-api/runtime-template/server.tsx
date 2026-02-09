/**
 * Hono Server
 *
 * API server with auto-generated routes from Prisma schema.
 * Customize this file to add middleware, auth, or custom routes.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'

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

// Serve static files in production
app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(`Server running on http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
