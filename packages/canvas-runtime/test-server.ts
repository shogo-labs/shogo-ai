/**
 * Standalone test server for canvas-runtime e2e testing.
 * Serves the built canvas-runtime files and provides mock SSE + action endpoints.
 *
 * Usage: bun run test-server.ts
 */

import { readFileSync, existsSync } from 'fs'
import { join, extname, resolve } from 'path'

const DIST_DIR = resolve(import.meta.dir, 'dist')
const PORT = 4321

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

const DASHBOARD_CODE = `
var _state = useState(0)
var count = _state[0], setCount = _state[1]

var _items = useState([
  { name: 'Widgets', revenue: 12400, status: 'active' },
  { name: 'Gadgets', revenue: 8300, status: 'active' },
  { name: 'Doodads', revenue: 4100, status: 'paused' },
])
var items = _items[0]

return h('div', { className: 'flex flex-col gap-6' }, [
  h('h1', { key: 'title', className: 'text-2xl font-bold' }, 'Canvas v2 Test Dashboard'),
  h(Row, { key: 'metrics', gap: 'md' }, [
    h(Metric, { key: 'm1', label: 'Total Revenue', value: 24800, unit: '$', trend: 'up', trendValue: '+12%' }),
    h(Metric, { key: 'm2', label: 'Products', value: items.length }),
    h(Metric, { key: 'm3', label: 'Click Count', value: count }),
  ]),
  h(Card, { key: 'card' }, [
    h(CardHeader, { key: 'ch' }, h(CardTitle, {}, 'Products')),
    h(CardContent, { key: 'cc' },
      h(Table, {}, [
        h(TableHeader, { key: 'thead' },
          h(TableRow, {}, [
            h(TableHead, { key: 'h1' }, 'Product'),
            h(TableHead, { key: 'h2' }, 'Revenue'),
            h(TableHead, { key: 'h3' }, 'Status'),
          ])
        ),
        h(TableBody, { key: 'tbody' },
          items.map(function(item, i) {
            return h(TableRow, { key: i }, [
              h(TableCell, { key: 'n' }, item.name),
              h(TableCell, { key: 'r' }, '$' + item.revenue.toLocaleString()),
              h(TableCell, { key: 's' }, h(Badge, { variant: item.status === 'active' ? 'default' : 'secondary' }, item.status)),
            ])
          })
        ),
      ])
    ),
  ]),
  h(Row, { key: 'actions', gap: 'sm' }, [
    h(Button, { key: 'btn', onClick: function() { setCount(function(c) { return c + 1 }) } }, 'Click me: ' + count),
    h(Badge, { key: 'badge', variant: 'outline' }, 'Canvas v2 is working!'),
  ]),
])
`

const CHART_CODE = `
var chartData = [
  { name: 'Jan', sales: 4000, profit: 2400 },
  { name: 'Feb', sales: 3000, profit: 1398 },
  { name: 'Mar', sales: 2000, profit: 9800 },
  { name: 'Apr', sales: 2780, profit: 3908 },
  { name: 'May', sales: 1890, profit: 4800 },
  { name: 'Jun', sales: 2390, profit: 3800 },
]

return h('div', { className: 'flex flex-col gap-6' }, [
  h('h1', { key: 't', className: 'text-2xl font-bold' }, 'Charts Tab'),
  h(Card, { key: 'chart' }, [
    h(CardHeader, { key: 'ch' }, h(CardTitle, {}, 'Sales vs Profit')),
    h(CardContent, { key: 'cc' },
      h(ResponsiveContainer, { width: '100%', height: 300 },
        h(BarChart, { data: chartData }, [
          h(CartesianGrid, { key: 'grid', strokeDasharray: '3 3' }),
          h(XAxis, { key: 'x', dataKey: 'name' }),
          h(YAxis, { key: 'y' }),
          h(RechartsTooltip, { key: 'tip' }),
          h(Legend, { key: 'leg' }),
          h(Bar, { key: 'b1', dataKey: 'sales', fill: '#3b82f6' }),
          h(Bar, { key: 'b2', dataKey: 'profit', fill: '#10b981' }),
        ])
      )
    ),
  ]),
  h(Alert, { key: 'info' }, [
    h(AlertTitle, { key: 'at' }, 'Multi-surface support'),
    h(AlertDescription, { key: 'ad' }, 'This is a second tab rendered from a separate canvas file. Each .js file = a tab.'),
  ]),
])
`

// SSE subscribers
const subscribers = new Set<(data: string) => void>()

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    // SSE endpoint
    if (path === '/agent/canvas/stream' || path === '/canvas/agent/canvas/stream') {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          const send = (data: string) => {
            try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)) } catch {}
          }

          // Send init with both surfaces
          send(JSON.stringify({
            type: 'init',
            surfaces: [
              { surfaceId: 'dashboard', title: 'Dashboard', code: DASHBOARD_CODE, data: {} },
              { surfaceId: 'charts', title: 'Charts', code: CHART_CODE, data: {} },
            ],
          }))

          const handler = (data: string) => send(data)
          subscribers.add(handler)

          const heartbeat = setInterval(() => {
            try { controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch {
              clearInterval(heartbeat)
              subscribers.delete(handler)
            }
          }, 15_000)

          req.signal.addEventListener('abort', () => {
            clearInterval(heartbeat)
            subscribers.delete(handler)
            try { controller.close() } catch {}
          })
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // Action endpoint
    if (path === '/agent/canvas/action' || path === '/canvas/agent/canvas/action') {
      if (req.method === 'POST') {
        const body = await req.json()
        console.log('[action]', JSON.stringify(body))
        return Response.json({ ok: true })
      }
    }

    // Serve canvas-runtime dist files
    let filePath: string
    if (path === '/canvas/' || path === '/canvas') {
      filePath = join(DIST_DIR, 'index.html')
    } else if (path.startsWith('/canvas/')) {
      const rel = path.slice('/canvas/'.length)
      filePath = join(DIST_DIR, rel)
    } else if (path === '/' || path === '') {
      filePath = join(DIST_DIR, 'index.html')
    } else {
      const rel = path.slice(1)
      filePath = join(DIST_DIR, rel)
    }

    if (!filePath.startsWith(resolve(DIST_DIR))) {
      return new Response('Forbidden', { status: 403 })
    }

    if (existsSync(filePath)) {
      const ext = extname(filePath).toLowerCase()
      const mime = MIME[ext] || 'application/octet-stream'
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': mime,
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // SPA fallback
    const indexPath = join(DIST_DIR, 'index.html')
    if (existsSync(indexPath)) {
      return new Response(readFileSync(indexPath), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
})

console.log(`Canvas v2 test server running at http://localhost:${PORT}`)
console.log(`  Canvas runtime: http://localhost:${PORT}/`)
console.log(`  SSE stream:     http://localhost:${PORT}/agent/canvas/stream`)
console.log(`  Two surfaces:   "dashboard" + "charts"`)
