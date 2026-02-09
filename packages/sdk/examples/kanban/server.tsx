/**
 * Kanban Board Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()
app.use('*', cors())

// Custom: Get full board with columns and cards
app.get('/api/boards/:id/full', async (c) => {
  const boardId = c.req.param('id')
  
  try {
    const board = await db.board.findUnique({
      where: { id: boardId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: { position: 'asc' },
              include: {
                labels: {
                  include: { label: true }
                }
              }
            }
          }
        },
        labels: true
      }
    })
    
    if (!board) {
      return c.json({ error: 'Board not found' }, 404)
    }
    
    return c.json(board)
  } catch (error) {
    console.error('Failed to get board:', error)
    return c.json({ error: 'Failed to get board' }, 500)
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
