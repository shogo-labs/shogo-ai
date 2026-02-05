/**
 * Feedback Form Server
 * 
 * Uses Hono for HTTP routes and Prisma for database access.
 * Extends SDK-generated routes with custom statistics endpoint.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { db } from './src/lib/db'

const app = new Hono()

// Enable CORS
app.use('*', cors())

// Custom route: Get submission statistics (must be before generated routes)
app.get('/api/submissions/stats', async (c) => {
  const userId = c.req.query('userId')
  
  if (!userId) {
    return c.json({ error: 'userId is required' }, 400)
  }

  try {
    // Get all submissions for aggregation
    const submissions = await db.submission.findMany({
      where: { userId },
    })

    const total = submissions.length
    const unread = submissions.filter(s => !s.isRead).length
    const starred = submissions.filter(s => s.isStarred).length
    
    // Calculate average rating
    const averageRating = total > 0 
      ? submissions.reduce((sum, s) => sum + s.rating, 0) / total 
      : 0

    // Calculate recommend rate
    const recommendCount = submissions.filter(s => s.wouldRecommend).length
    const recommendRate = total > 0 ? (recommendCount / total) * 100 : 0

    return c.json({
      total,
      unread,
      starred,
      averageRating: Math.round(averageRating * 10) / 10,
      recommendRate: Math.round(recommendRate),
    })
  } catch (error) {
    console.error('Failed to get stats:', error)
    return c.json({ error: 'Failed to get stats' }, 500)
  }
})

// Mount generated CRUD routes (after custom routes)
const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// Production: serve static files
app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3000', 10)

console.log(`🚀 Server running at http://localhost:${port}`)

export default {
  port,
  fetch: app.fetch,
}
