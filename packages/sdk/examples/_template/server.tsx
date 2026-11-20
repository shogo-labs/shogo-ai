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

// Runtime introspection — the agent runtime proxies these to know whether this
// server is really up and which routes it really registered (custom routes
// included). Outside /api so app routes can't collide; never public.
const startedAt = new Date().toISOString()
app.get('/__shogo/health', (c) => c.json({ ok: true, startedAt, pid: process.pid }))
app.get('/__shogo/routes', (c) => {
  const seen = new Set<string>()
  const routes: { method: string; path: string }[] = []
  for (const route of app.routes) {
    const method = String(route.method).toUpperCase()
    if (method === 'ALL' || method === 'USE') continue
    if (route.path.startsWith('/__shogo')) continue
    // Only the API surface — `/health` and the SPA catch-all are not API routes.
    if (!route.path.startsWith('/api/')) continue
    const key = `${method} ${route.path}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ method, path: route.path })
  }
  return c.json({ routes })
})

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(`Server running on http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
