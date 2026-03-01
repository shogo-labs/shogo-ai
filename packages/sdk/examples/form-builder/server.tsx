/**
 * Form Builder Server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma as db } from './src/lib/db'

const app = new Hono()
app.use('*', cors())

// Custom: Get form by slug with fields
app.get('/api/forms/slug/:slug', async (c) => {
  const slug = c.req.param('slug')
  
  try {
    const form = await db.form.findUnique({
      where: { slug },
      include: {
        fields: {
          orderBy: { position: 'asc' }
        }
      }
    })
    
    if (!form) {
      return c.json({ error: 'Form not found' }, 404)
    }
    
    return c.json(form)
  } catch (error) {
    console.error('Failed to get form:', error)
    return c.json({ error: 'Failed to get form' }, 500)
  }
})

// Custom: Get full form with fields
app.get('/api/forms/:id/full', async (c) => {
  const id = c.req.param('id')
  
  try {
    const form = await db.form.findUnique({
      where: { id },
      include: {
        fields: {
          orderBy: { position: 'asc' }
        }
      }
    })
    
    if (!form) {
      return c.json({ error: 'Form not found' }, 404)
    }
    
    return c.json(form)
  } catch (error) {
    console.error('Failed to get form:', error)
    return c.json({ error: 'Failed to get form' }, 500)
  }
})

// Custom: Submit form
app.post('/api/submit', async (c) => {
  try {
    const { formId, responses, respondentEmail } = await c.req.json()
    
    if (!formId || !responses) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    // Create submission with responses in a transaction
    const submission = await db.$transaction(async (tx) => {
      const sub = await tx.submission.create({
        data: {
          formId,
          respondentEmail: respondentEmail || null,
        }
      })

      // Create responses for each field
      const fieldIds = Object.keys(responses)
      for (const fieldId of fieldIds) {
        if (responses[fieldId]) {
          await tx.response.create({
            data: {
              submissionId: sub.id,
              fieldId,
              value: String(responses[fieldId]),
            }
          })
        }
      }

      return sub
    })

    return c.json({ ok: true, id: submission.id })
  } catch (error) {
    console.error('Submit error:', error)
    return c.json({ error: 'Failed to submit form' }, 500)
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
