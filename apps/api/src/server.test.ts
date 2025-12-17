/**
 * Test for the AI Chat API endpoint
 * Run with: bun test apps/api/src/server.test.ts
 * 
 * NOTE: Requires the API server to be running on port 8002
 * Start with: cd apps/api && bun run dev
 */

import { describe, test, expect, setDefaultTimeout } from 'bun:test'

// Claude responses can take a while
setDefaultTimeout(30000)

const API_URL = 'http://localhost:8002'

describe('API Server', () => {
  test('health check returns ok', async () => {
    const response = await fetch(`${API_URL}/api/health`)
    const data = await response.json()
    
    expect(response.ok).toBe(true)
    expect(data).toEqual({ ok: true })
  })

  test('chat endpoint accepts messages and returns text stream', async () => {
    const response = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Say hello in exactly 3 words' }
        ]
      })
    })

    console.log('Response status:', response.status)
    console.log('Content-Type:', response.headers.get('content-type'))
    
    // Should return text stream format (for streamProtocol: 'text')
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')

    // Read the stream
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body reader')
    }

    const decoder = new TextDecoder()
    let fullResponse = ''
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const chunk = decoder.decode(value, { stream: true })
      fullResponse += chunk
      console.log('Chunk:', chunk)
    }

    console.log('Full response:', fullResponse)
    console.log('Response length:', fullResponse.length)

    // Should have some text content
    expect(fullResponse.length).toBeGreaterThan(0)
    
    // Check for rate limit message
    if (fullResponse.includes("hit your limit")) {
      console.log('Note: Claude Code returned rate limit message')
    }
  })
})

