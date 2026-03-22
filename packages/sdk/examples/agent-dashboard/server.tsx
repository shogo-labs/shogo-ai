import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma } from './src/lib/db'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: ["http://localhost:5173","http://localhost:3000"],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

app.get('/health', (c) => c.json({ ok: true, timestamp: new Date().toISOString() }))

app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(`Server running on http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
