/**
 * AI Chat Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()
app.use('*', cors())

// Generated routes
const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// Static files
app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3000', 10)
console.log(`🚀 Server running at http://localhost:${port}`)

export default { port, fetch: app.fetch }
