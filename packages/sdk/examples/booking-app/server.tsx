/**
 * Booking App Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()
app.use('*', cors())

// Custom: Create public booking
app.post('/api/book', async (c) => {
  try {
    const data = await c.req.json()
    const { userId, serviceId, customerName, customerEmail, customerPhone, notes, startTime, endTime } = data

    if (!userId || !serviceId || !customerName || !customerEmail || !startTime || !endTime) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    // Generate confirmation code
    const confirmationCode = `BK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`

    const booking = await db.booking.create({
      data: {
        userId,
        serviceId,
        customerName,
        customerEmail,
        customerPhone,
        notes,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        confirmationCode,
        status: 'PENDING',
      },
    })

    return c.json({ ok: true, confirmationCode: booking.confirmationCode, id: booking.id })
  } catch (error) {
    console.error('Booking error:', error)
    return c.json({ error: 'Failed to create booking' }, 500)
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
