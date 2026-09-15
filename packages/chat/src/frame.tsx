import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatPage } from './react.js'
import { createChatClient, type ChatVisitor } from './index.js'

const params = new URLSearchParams(window.location.search)
const client = createChatClient({
  apiUrl: params.get('apiUrl') || window.location.origin,
  projectId: params.get('projectId') || '',
  publishableKey: params.get('publishableKey') || undefined,
  widgetKey: params.get('widgetKey') || undefined,
  agentName: params.get('agentName') || undefined,
  transport: params.get('transport') === 'persona' ? 'persona' : 'runtime',
  embedOrigin: params.get('parentOrigin') || undefined,
})

window.addEventListener('message', (event) => {
  const parentOrigin = params.get('parentOrigin')
  if (event.source !== window.parent || (parentOrigin && event.origin !== parentOrigin)) return
  if (event.data?.type === 'shogo-chat:identify') {
    client.identify((event.data.visitor || {}) as ChatVisitor)
  }
})

const root = document.createElement('div')
root.id = 'shogo-chat-root'
root.style.cssText = 'height:100vh;'
document.body.style.margin = '0'
document.body.appendChild(root)

createRoot(root).render(
  <ChatPage
    client={client}
    title={params.get('title') || undefined}
    subtitle={params.get('subtitle') || undefined}
    placeholder={params.get('placeholder') || undefined}
    poweredBy={params.get('poweredBy') !== 'false'}
    style={{
      '--shogo-chat-primary': params.get('primaryColor') || undefined,
    } as React.CSSProperties}
  />,
)
