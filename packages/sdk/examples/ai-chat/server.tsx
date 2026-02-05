/**
 * AI Chat Server
 * Based on Vercel AI Chatbot - adapted for Shogo SDK
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { streamText, convertToCoreMessages } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAllRoutes } from './src/generated/index.js'
import { prisma as db } from './src/lib/db.js'
import { nanoid } from 'nanoid'

const app = new Hono()
app.use('*', cors())

// Generated CRUD routes for data persistence
const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// System prompt for the AI
const SYSTEM_PROMPT = `You are a helpful AI assistant. Be concise, helpful, and friendly.
When appropriate, use markdown formatting to make your responses clearer.
If you don't know something, say so honestly.`

// Get AI model based on configuration
function getAIModel(modelId: string = 'gpt-4o-mini') {
  const openaiKey = process.env.OPENAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  
  if (modelId.startsWith('claude') && anthropicKey) {
    const anthropic = createAnthropic({ apiKey: anthropicKey })
    return anthropic(modelId)
  }
  
  if (openaiKey) {
    const openai = createOpenAI({ apiKey: openaiKey })
    return openai(modelId)
  }
  
  return null
}

// AI Chat streaming endpoint
app.post('/api/chat', async (c) => {
  try {
    const body = await c.req.json()
    const { id: chatId, message, selectedChatModel = 'gpt-4o-mini', userId } = body
    
    if (!message || !chatId) {
      return c.json({ error: 'Message and chat ID are required' }, 400)
    }

    // Check if we have an AI model configured
    const model = getAIModel(selectedChatModel)
    
    if (!model) {
      // Demo mode - return a simulated response
      return handleDemoMode(c, chatId, message, userId)
    }

    // Real AI streaming
    try {
      // Save user message
      if (userId) {
        await db.message.create({
          data: {
            id: message.id || nanoid(),
            chatId,
            role: 'user',
            parts: JSON.stringify(message.parts || [{ type: 'text', text: message.content || '' }]),
            attachments: '[]',
          }
        })
      }

      // Get message history for context
      const historyMessages = await db.message.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        take: 20, // Last 20 messages for context
      })

      // Convert to AI SDK format
      const messages = historyMessages.map(m => {
        const parts = JSON.parse(m.parts || '[]')
        const textPart = parts.find((p: any) => p.type === 'text')
        return {
          role: m.role as 'user' | 'assistant',
          content: textPart?.text || '',
        }
      })

      // Add current message if not already in history
      const userContent = message.parts?.find((p: any) => p.type === 'text')?.text || message.content || ''
      if (!messages.some(m => m.content === userContent)) {
        messages.push({ role: 'user' as const, content: userContent })
      }

      // Stream the response
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: convertToCoreMessages(messages),
        onFinish: async ({ text }) => {
          // Save assistant response
          if (userId) {
            await db.message.create({
              data: {
                id: nanoid(),
                chatId,
                role: 'assistant',
                parts: JSON.stringify([{ type: 'text', text }]),
                attachments: '[]',
              }
            })

            // Update chat title if this is the first message
            const messageCount = await db.message.count({ where: { chatId } })
            if (messageCount <= 2) {
              const title = userContent.slice(0, 50) + (userContent.length > 50 ? '...' : '')
              await db.chat.update({
                where: { id: chatId },
                data: { title }
              })
            }
          }
        },
      })

      return result.toDataStreamResponse()
    } catch (aiError) {
      console.error('AI streaming error:', aiError)
      // Fall back to demo mode on AI error
      return handleDemoMode(c, chatId, message, userId)
    }
  } catch (error) {
    console.error('Chat error:', error)
    return c.json({ error: 'Failed to process chat request' }, 500)
  }
})

// Demo mode handler
async function handleDemoMode(c: any, chatId: string, message: any, userId?: string) {
  const userContent = message.parts?.find((p: any) => p.type === 'text')?.text || message.content || ''
  const demoResponse = getDemoResponse(userContent)
  
  // Save messages if we have userId
  if (userId) {
    await db.message.create({
      data: {
        id: message.id || nanoid(),
        chatId,
        role: 'user',
        parts: JSON.stringify(message.parts || [{ type: 'text', text: userContent }]),
        attachments: '[]',
      }
    })
    
    await db.message.create({
      data: {
        id: nanoid(),
        chatId,
        role: 'assistant',
        parts: JSON.stringify([{ type: 'text', text: demoResponse }]),
        attachments: '[]',
      }
    })

    // Update chat title
    const messageCount = await db.message.count({ where: { chatId } })
    if (messageCount <= 2) {
      const title = userContent.slice(0, 50) + (userContent.length > 50 ? '...' : '')
      await db.chat.update({
        where: { id: chatId },
        data: { title }
      })
    }
  }
  
  // Stream the demo response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const words = demoResponse.split(' ')
      for (let i = 0; i < words.length; i++) {
        const text = words[i] + (i < words.length - 1 ? ' ' : '')
        const chunk = `0:${JSON.stringify(text)}\n`
        controller.enqueue(encoder.encode(chunk))
        await new Promise(r => setTimeout(r, 30))
      }
      // Send finish event
      controller.enqueue(encoder.encode(`e:{"finishReason":"stop"}\n`))
      controller.enqueue(encoder.encode(`d:{"finishReason":"stop"}\n`))
      controller.close()
    }
  })
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Demo-Mode': 'true',
    }
  })
}

// Demo response generator
function getDemoResponse(input: string): string {
  const lowerInput = input.toLowerCase()
  
  if (lowerInput.includes('hello') || lowerInput.includes('hi')) {
    return "Hello! I'm an AI assistant running in demo mode. How can I help you today? (Note: Set OPENAI_API_KEY or ANTHROPIC_API_KEY for real AI responses)"
  }
  
  if (lowerInput.includes('help')) {
    return "I'm here to help! In demo mode, I provide simulated responses. To enable real AI capabilities, configure your API keys in the environment variables."
  }
  
  if (lowerInput.includes('weather')) {
    return "I don't have access to real-time weather data in demo mode, but I can help with other questions!"
  }
  
  if (lowerInput.includes('code') || lowerInput.includes('program')) {
    return "I can help with coding questions! In demo mode, I provide general guidance. With AI enabled, I can write and explain code in detail."
  }
  
  if (lowerInput.includes('thanks') || lowerInput.includes('thank you')) {
    return "You're welcome! Let me know if you need anything else."
  }
  
  const responses = [
    "That's an interesting question! In a full implementation with AI enabled, I would provide a detailed response.",
    "I understand what you're asking. This is a demo response - enable AI for real assistance.",
    "Great question! Configure your AI API keys to get intelligent responses.",
    "I'd be happy to help with that. Set up your API keys for full AI capabilities.",
  ]
  
  return responses[Math.floor(Math.random() * responses.length)]
}

// Vote on message
app.post('/api/vote', async (c) => {
  try {
    const { chatId, messageId, isUpvoted } = await c.req.json()
    
    await db.vote.upsert({
      where: {
        chatId_messageId: { chatId, messageId }
      },
      update: { isUpvoted },
      create: { chatId, messageId, isUpvoted }
    })
    
    return c.json({ success: true })
  } catch (error) {
    console.error('Vote error:', error)
    return c.json({ error: 'Failed to save vote' }, 500)
  }
})

// Get votes for a chat
app.get('/api/vote', async (c) => {
  const chatId = c.req.query('chatId')
  if (!chatId) {
    return c.json({ error: 'Chat ID required' }, 400)
  }
  
  const votes = await db.vote.findMany({
    where: { chatId }
  })
  
  return c.json(votes)
})

// Delete all chats for a user (history)
app.delete('/api/history', async (c) => {
  const userId = c.req.query('userId')
  if (!userId) {
    return c.json({ error: 'User ID required' }, 400)
  }
  
  await db.chat.deleteMany({
    where: { userId }
  })
  
  return c.json({ success: true })
})

// Static files
app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

const port = parseInt(process.env.PORT || '3005', 10)
const hasAI = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
console.log(`🚀 AI Chat Server running at http://localhost:${port}`)
console.log(`🤖 AI Mode: ${hasAI ? 'Enabled' : 'Demo (set OPENAI_API_KEY or ANTHROPIC_API_KEY)'}`)

export default { port, fetch: app.fetch }
