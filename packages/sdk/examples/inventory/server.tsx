/**
 * Inventory Manager Server
 * 
 * Uses Hono for HTTP routes and Prisma for database access.
 * Extends SDK-generated routes with custom stock management and summary endpoints.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()

// Enable CORS
app.use('*', cors())

// =============================================================================
// Custom Routes (before generated routes)
// =============================================================================

// Get inventory summary
app.get('/api/summary', async (c) => {
  const userId = c.req.query('userId')
  
  if (!userId) {
    return c.json({ error: 'userId is required' }, 400)
  }

  try {
    const products = await db.product.findMany({
      where: { userId },
      include: { category: true },
    })

    const totalProducts = products.length
    const totalValue = products.reduce((sum, p) => sum + p.price * p.quantity, 0)
    const lowStockProducts = products.filter(p => p.quantity <= p.minQuantity)
    const lowStockCount = lowStockProducts.length
    const outOfStockCount = products.filter(p => p.quantity === 0).length

    // Group by category
    const categoryMap = new Map<string, { category: any; count: number; value: number }>()
    for (const product of products) {
      const catId = product.categoryId
      if (!categoryMap.has(catId)) {
        categoryMap.set(catId, {
          category: product.category,
          count: 0,
          value: 0,
        })
      }
      const entry = categoryMap.get(catId)!
      entry.count++
      entry.value += product.price * product.quantity
    }

    const productsByCategory = Array.from(categoryMap.values())

    return c.json({
      totalProducts,
      totalValue,
      lowStockCount,
      outOfStockCount,
      lowStockProducts,
      productsByCategory,
    })
  } catch (error) {
    console.error('Failed to get summary:', error)
    return c.json({ error: 'Failed to get summary' }, 500)
  }
})

// Add stock
app.post('/api/stock/add', async (c) => {
  const body = await c.req.json()
  const { productId, quantity, reason, userId } = body

  if (!productId || !quantity || !userId) {
    return c.json({ error: 'productId, quantity, and userId are required' }, 400)
  }

  try {
    // Verify product exists and belongs to user
    const product = await db.product.findFirst({
      where: { id: productId, userId },
    })

    if (!product) {
      return c.json({ error: 'Product not found' }, 404)
    }

    // Update product quantity and create movement
    const [updatedProduct, movement] = await db.$transaction([
      db.product.update({
        where: { id: productId },
        data: { quantity: product.quantity + quantity },
      }),
      db.stockMovement.create({
        data: {
          type: 'in',
          quantity,
          reason,
          productId,
          userId,
        },
      }),
    ])

    return c.json({ ok: true, product: updatedProduct, movement })
  } catch (error) {
    console.error('Failed to add stock:', error)
    return c.json({ error: 'Failed to add stock' }, 500)
  }
})

// Remove stock
app.post('/api/stock/remove', async (c) => {
  const body = await c.req.json()
  const { productId, quantity, reason, userId } = body

  if (!productId || !quantity || !userId) {
    return c.json({ error: 'productId, quantity, and userId are required' }, 400)
  }

  try {
    // Verify product exists and belongs to user
    const product = await db.product.findFirst({
      where: { id: productId, userId },
    })

    if (!product) {
      return c.json({ error: 'Product not found' }, 404)
    }

    if (product.quantity < quantity) {
      return c.json({ error: 'Insufficient stock' }, 400)
    }

    // Update product quantity and create movement
    const [updatedProduct, movement] = await db.$transaction([
      db.product.update({
        where: { id: productId },
        data: { quantity: product.quantity - quantity },
      }),
      db.stockMovement.create({
        data: {
          type: 'out',
          quantity,
          reason,
          productId,
          userId,
        },
      }),
    ])

    return c.json({ ok: true, product: updatedProduct, movement })
  } catch (error) {
    console.error('Failed to remove stock:', error)
    return c.json({ error: 'Failed to remove stock' }, 500)
  }
})

// =============================================================================
// Generated Routes
// =============================================================================

const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// =============================================================================
// Static Files (Production)
// =============================================================================

app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3000', 10)

console.log(`🚀 Server running at http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
