import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChatLauncher, ChatPage } from '@shogo-ai/chat/react'
import { createChatClient } from '@shogo-ai/chat'
import '@shogo-ai/chat/styles.css'

const client = createChatClient({
  apiUrl: import.meta.env.VITE_SHOGO_API_URL,
  projectId: import.meta.env.VITE_SHOGO_PROJECT_ID,
  publishableKey: import.meta.env.VITE_SHOGO_PUBLISHABLE_KEY,
  transport: import.meta.env.VITE_SHOGO_CHAT_TRANSPORT === 'runtime' ? 'runtime' : 'persona',
})

function App() {
  return (
    <main style={{ minHeight: '100vh', padding: 32 }}>
      <h1>Embedded Agent Chat</h1>
      <p>Try the launcher, or use the full-page surface below.</p>
      <div style={{ height: 520, maxWidth: 720 }}>
        <ChatPage client={client} />
      </div>
      <ChatLauncher client={client} title="Chat with us" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
