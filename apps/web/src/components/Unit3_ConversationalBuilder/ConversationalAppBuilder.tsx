import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useAgentChat, type ChatMessage } from '../../hooks/useAgentChat'
import { useSchemaPreview } from '../../hooks/useSchemaPreview'
import { DynamicCollectionList } from './DynamicCollectionList'

/**
 * ConversationalAppBuilder - Main component for Unit 3
 *
 * Side-by-side layout:
 * - Left panel: Chat interface for conversing with Claude
 * - Right panel: Preview of generated app (shows after schema creation)
 */
export function ConversationalAppBuilder() {
  const [generatedSchemaName, setGeneratedSchemaName] = useState<string | null>(null)
  const chat = useAgentChat()

  // Watch for schema tool calls to update preview
  // agent_chat calls schema_set/schema_load directly, so we only need to detect those
  useEffect(() => {
    for (const msg of chat.messages) {
      if (msg.role !== 'assistant' || !msg.toolCalls) continue

      for (const tc of msg.toolCalls) {
        // Detect schema tools - all use args.name for the schema name
        const schemaTools = [
          'mcp__wavesmith__schema_set',
          'mcp__wavesmith__schema_load',
          'mcp__wavesmith__schema_get'
        ]

        if (schemaTools.includes(tc.tool) && tc.args?.name) {
          const schemaName = tc.args.name
          if (schemaName !== generatedSchemaName) {
            setGeneratedSchemaName(schemaName)
            return
          }
        }
      }
    }
  }, [chat.messages, generatedSchemaName])

  return (
    <div style={{
      display: 'flex',
      gap: '1rem',
      flex: 1,
      minHeight: 0,
    }}>
      {/* Left Panel: Chat */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        border: '2px solid #3b82f6',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '0.75rem 1rem',
          background: '#3b82f6',
          color: 'white',
          fontWeight: 'bold',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>Chat with Claude</span>
          {chat.sessionId && (
            <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>
              Session: {chat.sessionId.slice(0, 8)}...
            </span>
          )}
        </div>
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: '#f8fafc',
          overflow: 'hidden',
        }}>
          <ChatPanel
            messages={chat.messages}
            isLoading={chat.isLoading}
            error={chat.error}
            onSendMessage={chat.sendMessage}
            onReset={chat.reset}
          />
        </div>
      </div>

      {/* Right Panel: Preview */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        border: '2px solid #10b981',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '0.75rem 1rem',
          background: '#10b981',
          color: 'white',
          fontWeight: 'bold',
        }}>
          Generated App Preview
        </div>
        <div style={{
          flex: 1,
          padding: '1rem',
          overflowY: 'auto',
          background: '#f0fdf4',
        }}>
          {generatedSchemaName ? (
            <SchemaPreviewPanel schemaName={generatedSchemaName} />
          ) : (
            <EmptyPreviewState />
          )}
        </div>
      </div>
    </div>
  )
}

interface ChatPanelProps {
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
  onSendMessage: (content: string) => Promise<boolean>
  onReset: () => void
}

function ChatPanel({ messages, isLoading, error, onSendMessage, onReset }: ChatPanelProps) {
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!inputValue.trim() || isLoading) return
    const message = inputValue
    setInputValue('')
    await onSendMessage(message)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Messages area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {messages.length === 0 ? (
          <div style={{
            padding: '1rem',
            background: 'white',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
            color: '#64748b',
            fontStyle: 'italic',
          }}>
            Start a conversation by describing what kind of app you want to build...
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}

        {isLoading && (
          <div style={{
            padding: '1rem',
            background: '#dbeafe',
            borderRadius: '8px',
            marginTop: '0.5rem',
            color: '#1e40af',
          }}>
            Claude is thinking...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error display */}
      {error && (
        <div style={{
          margin: '0 1rem',
          padding: '0.75rem',
          background: '#fee2e2',
          border: '1px solid #ef4444',
          borderRadius: '4px',
          color: '#991b1b',
          fontSize: '0.9rem',
        }}>
          Error: {error}
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: '1rem', borderTop: '1px solid #e2e8f0', background: 'white' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the app you want to build..."
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '0.75rem',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              resize: 'none',
              minHeight: '60px',
              fontFamily: 'inherit',
              fontSize: '0.95rem',
              opacity: isLoading ? 0.6 : 1,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <button
              onClick={handleSend}
              disabled={!inputValue.trim() || isLoading}
              style={{
                padding: '0.75rem 1.5rem',
                background: !inputValue.trim() || isLoading ? '#94a3b8' : '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: !inputValue.trim() || isLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {isLoading ? '...' : 'Send'}
            </button>
            {messages.length > 0 && (
              <button
                onClick={onReset}
                disabled={isLoading}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'transparent',
                  color: '#64748b',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div style={{
      marginBottom: '0.75rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        padding: '0.75rem 1rem',
        borderRadius: '12px',
        maxWidth: '85%',
        background: isUser ? '#3b82f6' : 'white',
        color: isUser ? 'white' : '#1e293b',
        border: isUser ? 'none' : '1px solid #e2e8f0',
      }}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>

        {/* Show tool calls for assistant messages */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{
            marginTop: '0.5rem',
            paddingTop: '0.5rem',
            borderTop: '1px solid rgba(0,0,0,0.1)',
            fontSize: '0.8rem',
            color: '#64748b',
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Tools used:</div>
            {message.toolCalls.map((tc, i) => (
              <div key={i} style={{ marginLeft: '0.5rem' }}>
                {tc.tool}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{
        fontSize: '0.7rem',
        color: '#94a3b8',
        marginTop: '0.25rem',
      }}>
        {message.timestamp.toLocaleTimeString()}
      </div>
    </div>
  )
}

function EmptyPreviewState() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: '#64748b',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🏗️</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
        No App Generated Yet
      </div>
      <div style={{ fontSize: '0.9rem', maxWidth: '300px' }}>
        Chat with Claude to describe your app. Once the schema is generated,
        a working CRUD interface will appear here.
      </div>
    </div>
  )
}

/**
 * SchemaPreviewPanel - Loads schema and renders dynamic CRUD lists
 *
 * Uses observer() for MobX reactivity - any collection changes
 * will automatically trigger re-renders.
 */
const SchemaPreviewPanel = observer(function SchemaPreviewPanel({ schemaName }: { schemaName: string }) {
  const { schema, runtimeStore, models, loading, error } = useSchemaPreview(schemaName)

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#059669',
      }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
        <div>Loading schema...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: '1rem',
        background: '#fef2f2',
        borderRadius: '8px',
        border: '1px solid #fca5a5',
        color: '#991b1b',
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Error Loading Schema</div>
        <div style={{ fontSize: '0.9rem' }}>{error}</div>
      </div>
    )
  }

  if (!schema || !runtimeStore) {
    return (
      <div style={{
        padding: '1rem',
        background: 'white',
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        color: '#64748b',
      }}>
        Schema not available
      </div>
    )
  }

  // Build collections from cached models array (avoids MST computed view issues)
  const collections = models.map((model: any) => {
    // Convert model name to collection name: "Page" → "pageCollection"
    const collectionName = `${model.name.charAt(0).toLowerCase()}${model.name.slice(1)}Collection`
    return {
      modelName: model.name,
      collectionName,
      collection: runtimeStore[collectionName],
      model  // Pass full model entity for schema-aware defaults
    }
  }).filter((c: any) => c.collection)

  return (
    <div>
      {/* Schema Header */}
      <div style={{
        marginBottom: '1rem',
        padding: '0.75rem 1rem',
        background: '#dbeafe',
        borderRadius: '8px',
        border: '1px solid #93c5fd',
      }}>
        <div style={{ fontWeight: 'bold', color: '#1e40af' }}>
          Schema: {schema.name}
        </div>
        <div style={{ fontSize: '0.8rem', color: '#3b82f6', marginTop: '0.25rem' }}>
          {models.length} model{models.length !== 1 ? 's' : ''}: {models.map((m: any) => m.name).join(', ')}
        </div>
      </div>

      {/* Collection Lists */}
      {collections.length === 0 ? (
        <div style={{
          padding: '1rem',
          background: 'white',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          color: '#64748b',
          textAlign: 'center',
        }}>
          No collections found in schema
        </div>
      ) : (
        collections.map((c: any) => (
          <DynamicCollectionList
            key={c.collectionName}
            collection={c.collection}
            modelName={c.modelName}
            model={c.model}
          />
        ))
      )}
    </div>
  )
})
