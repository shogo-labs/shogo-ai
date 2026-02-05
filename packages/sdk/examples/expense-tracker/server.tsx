/**
 * Expense Tracker Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()
app.use('*', cors())

// Custom: Summary
app.get('/api/summary', async (c) => {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'userId required' }, 400)

  try {
    const transactions = await db.transaction.findMany({
      where: { userId },
      include: { category: true },
    })

    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
    const totalExpenses = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    const balance = totalIncome - totalExpenses

    const categoryMap = new Map<string, { category: any; amount: number }>()
    for (const t of transactions) {
      if (!categoryMap.has(t.categoryId)) {
        categoryMap.set(t.categoryId, { category: t.category, amount: 0 })
      }
      categoryMap.get(t.categoryId)!.amount += t.type === 'expense' ? t.amount : -t.amount
    }

    return c.json({ totalIncome, totalExpenses, balance, byCategory: Array.from(categoryMap.values()) })
  } catch (error) {
    console.error('Summary error:', error)
    return c.json({ error: 'Failed to get summary' }, 500)
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
