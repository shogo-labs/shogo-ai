/**
 * CRM Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()

app.use('*', cors())

// Custom: Contact stats
app.get('/api/contacts/stats', async (c) => {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'userId required' }, 400)

  try {
    const contacts = await db.contact.findMany({ where: { userId } })
    const stats = {
      total: contacts.length,
      leads: contacts.filter(c => c.status === 'lead').length,
      prospects: contacts.filter(c => c.status === 'prospect').length,
      customers: contacts.filter(c => c.status === 'customer').length,
      churned: contacts.filter(c => c.status === 'churned').length,
    }
    return c.json(stats)
  } catch (error) {
    console.error('Stats error:', error)
    return c.json({ error: 'Failed to get stats' }, 500)
  }
})

// Custom: Deal pipeline
app.get('/api/deals/pipeline', async (c) => {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'userId required' }, 400)

  try {
    const deals = await db.deal.findMany({ where: { userId } })
    
    const stages = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
    const pipeline = stages.map(stage => ({
      stage,
      count: deals.filter(d => d.stage === stage).length,
      value: deals.filter(d => d.stage === stage).reduce((sum, d) => sum + d.value, 0),
    }))

    const totalValue = deals.filter(d => !['won', 'lost'].includes(d.stage)).reduce((sum, d) => sum + d.value, 0)
    const wonValue = deals.filter(d => d.stage === 'won').reduce((sum, d) => sum + d.value, 0)

    return c.json({ pipeline, totalValue, wonValue })
  } catch (error) {
    console.error('Pipeline error:', error)
    return c.json({ error: 'Failed to get pipeline' }, 500)
  }
})

// Generated routes
const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// Static files
app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3001', 10)
console.log(`🚀 Server running at http://localhost:${port}`)

export default { port, fetch: app.fetch }
