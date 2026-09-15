import { describe, expect, test } from 'bun:test'
import { createChatClient } from './index'

function streamResponse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('ChatClient', () => {
  test('streams persona text into a UI message', async () => {
    const requests: Request[] = []
    const client = createChatClient({
      apiUrl: 'https://api.example.test',
      projectId: 'project-1',
      publishableKey: 'shogo_pk_test',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return streamResponse([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Hello' },
          { type: 'text-delta', id: 'text-1', delta: ' visitor' },
          { type: 'text-end', id: 'text-1' },
        ])
      },
    })

    await client.send('Hi')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/api/chat/turn?projectId=project-1')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer shogo_pk_test')
    expect(client.messages.map((message) => ({
      role: message.role,
      text: message.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''),
    }))).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello visitor' },
    ])
  })

  test('reuses the same runtime session across turns', async () => {
    const calls: Request[] = []
    const client = createChatClient({
      apiUrl: 'https://api.example.test',
      projectId: 'project-1',
      publishableKey: 'shogo_pk_test',
      transport: 'runtime',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request)
        if (request.url.endsWith('/session')) {
          return new Response(JSON.stringify({ sessionId: 'visitor-session', sessionToken: 'token' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return streamResponse([{ type: 'text-delta', delta: 'ok' }])
      },
    })

    await client.send('One')
    await client.send('Two')

    const messages = calls.filter((request) => request.url.endsWith('/message'))
    expect(messages).toHaveLength(2)
    expect(JSON.parse(await messages[0]!.clone().text()).sessionId).toBe('visitor-session')
    expect(JSON.parse(await messages[1]!.clone().text()).sessionId).toBe('visitor-session')
  })

  test('forwards legacy widget keys and renders streamed tool parts', async () => {
    let sessionRequest: Request | undefined
    const client = createChatClient({
      apiUrl: 'https://api.example.test',
      projectId: 'project-1',
      widgetKey: 'legacy-widget',
      transport: 'runtime',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.endsWith('/session')) {
          sessionRequest = request
          return new Response(JSON.stringify({ sessionId: 'session-1', sessionToken: 'token-1' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return streamResponse([
          { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'search' },
          { type: 'tool-input-delta', toolCallId: 'call-1', delta: '{"q":"docs"}' },
          { type: 'tool-input-available', toolCallId: 'call-1', input: { q: 'docs' } },
          { type: 'tool-output-available', toolCallId: 'call-1', output: { count: 1 } },
        ])
      },
    })

    await client.send('Search the docs')
    expect(sessionRequest?.headers.get('x-webchat-widget-key')).toBe('legacy-widget')
    const tool = client.messages[1]?.parts[1] as any
    expect(tool).toMatchObject({
      type: 'dynamic-tool',
      toolCallId: 'call-1',
      toolName: 'search',
      state: 'output-available',
      output: { count: 1 },
    })
  })
})
