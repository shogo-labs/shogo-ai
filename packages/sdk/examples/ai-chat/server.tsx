// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Chat Server
 * Shogo AI Chat Server
 *
 * AI Model Access:
 * 1. Shogo AI Proxy (preferred) - Uses AI_PROXY_URL + AI_PROXY_TOKEN
 *    No API keys needed! The proxy is provided by the Shogo platform.
 * 2. Direct API keys (fallback) - Uses OPENAI_API_KEY or ANTHROPIC_API_KEY
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { streamText, type UIMessage, convertToModelMessages } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAllRoutes } from './src/generated/index.js'
import { prisma as db } from './src/lib/db.js'
import { nanoid } from 'nanoid'

const app = new Hono()
app.use('*', cors())

// Generated CRUD routes for data persistence
const generatedRoutes = createAllRoutes(db)
app.route('/api', generatedRoutes)

// Debug endpoint (remove in production)
app.get('/api/debug-env', (c) => {
  return c.json({
    hasProxy: !!(process.env.AI_PROXY_URL && process.env.AI_PROXY_TOKEN),
    proxyUrl: process.env.AI_PROXY_URL || 'not set',
    proxyTokenLen: process.env.AI_PROXY_TOKEN?.length || 0,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY,
  })
})

// System prompt for the AI
const SYSTEM_PROMPT = `You are a helpful AI assistant. Be concise, helpful, and friendly.
When appropriate, use markdown formatting to make your responses clearer.
If you don't know something, say so honestly.`

/**
 * Get AI model based on configuration.
 *
 * Priority:
 * 1. Shogo AI Proxy (AI_PROXY_URL + AI_PROXY_TOKEN) - uses native Anthropic endpoint
 * 2. Direct Anthropic API key (ANTHROPIC_API_KEY)
 * 3. null (demo mode)
 */
function getAIModel(modelId: string = 'claude-haiku-4-5') {
  // 1. Shogo AI Proxy - preferred, no raw API keys needed
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN
  
  if (proxyUrl && proxyToken) {
    // Derive the Anthropic-native proxy URL from the base proxy URL
    // e.g. http://localhost:8002/api/ai/v1 -> http://localhost:8002/api/ai/anthropic/v1
    const anthropicProxyUrl = proxyUrl.replace('/ai/v1', '/ai/anthropic/v1')
    
    const anthropic = createAnthropic({
      baseURL: anthropicProxyUrl,
      apiKey: proxyToken, // Proxy token sent as x-api-key
    })
    return anthropic(modelId)
  }

  // 2. Direct Anthropic API key (fallback for local development without proxy)
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  
  if (anthropicKey) {
    const anthropic = createAnthropic({ apiKey: anthropicKey })
    return anthropic(modelId)
  }
  
  return null
}

// AI Chat streaming endpoint (AI SDK v6)
app.post('/api/chat', async (c) => {
  try {
    const body = await c.req.json()
    const { id: chatId, message, messages: allMessages, selectedChatModel = 'claude-haiku-4-5', userId } = body
    
    if (!chatId) {
      return c.json({ error: 'Chat ID is required' }, 400)
    }

    // Extract user content from message or messages array
    const lastMessage = message || (allMessages && allMessages[allMessages.length - 1])
    if (!lastMessage) {
      return c.json({ error: 'Message is required' }, 400)
    }

    const userContent = lastMessage.parts?.find((p: any) => p.type === 'text')?.text || lastMessage.content || ''

    // Check if we have an AI model configured
    const model = getAIModel(selectedChatModel)
    
    if (!model) {
      // Demo mode - return a simulated response
      return handleDemoMode(c, chatId, lastMessage, userId)
    }

    // Real AI streaming
    try {
      // Save user message (upsert to handle retries gracefully)
      if (userId && lastMessage.role === 'user') {
        const msgId = lastMessage.id || nanoid()
        await db.message.upsert({
          where: { id: msgId },
          update: {},
          create: {
            id: msgId,
            chatId,
            role: 'user',
            parts: JSON.stringify(lastMessage.parts || [{ type: 'text', text: userContent }]),
            attachments: '[]',
          }
        })
      }

      // Build messages for the AI model
      // If allMessages are provided (v6 format), use them directly
      let uiMessages: UIMessage[]
      if (allMessages && allMessages.length > 0) {
        uiMessages = allMessages
      } else {
        // Fall back to fetching from DB
        const historyMessages = await db.message.findMany({
          where: { chatId },
          orderBy: { createdAt: 'asc' },
          take: 20,
        })

        uiMessages = historyMessages.map(m => {
          const parts = JSON.parse(m.parts || '[]')
          return {
            id: m.id,
            role: m.role as 'user' | 'assistant',
            parts: parts,
          }
        }) as UIMessage[]

        // Add current message if not already in history
        if (!uiMessages.some(m => m.id === lastMessage.id)) {
          uiMessages.push(lastMessage as UIMessage)
        }
      }

      // Convert UIMessages to model messages for AI SDK v6
      const modelMessages = await convertToModelMessages(uiMessages)

      // Stream the response
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: modelMessages,
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

      // Return UIMessage stream response for AI SDK v6 DefaultChatTransport
      return result.toUIMessageStreamResponse()
    } catch (aiError) {
      console.error('AI streaming error:', aiError)
      // Fall back to demo mode on AI error
      return handleDemoMode(c, chatId, lastMessage, userId)
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

const port = parseInt(process.env.PORT || '3001', 10)
const hasProxy = !!(process.env.AI_PROXY_URL && process.env.AI_PROXY_TOKEN)
const hasDirectAI = !!process.env.ANTHROPIC_API_KEY
const hasAI = hasProxy || hasDirectAI
console.log(`🚀 AI Chat Server running at http://localhost:${port}`)
if (hasProxy) {
  console.log(`🤖 AI Mode: Shogo Proxy (${process.env.AI_PROXY_URL})`)
} else if (hasDirectAI) {
  console.log(`🤖 AI Mode: Direct API Keys`)
} else {
  console.log(`🤖 AI Mode: Demo (set AI_PROXY_URL+AI_PROXY_TOKEN or OPENAI_API_KEY/ANTHROPIC_API_KEY)`)
}

export default { port, fetch: app.fetch }
