import React, { useEffect, useState } from 'react'
import {
  ChatHeader,
  ChatUiHostProvider,
  QuickActionChips,
  TurnList,
} from '@shogo/chat-ui'
import type { UIMessage } from 'ai'
import { ChatClient, type ChatClientConfig, type ChatStatus } from './index.js'
import '@shogo/chat-ui/styles.css'

export interface ShogoChatProviderProps {
  client: ChatClient
  children: React.ReactNode
}

const ChatClientContext = React.createContext<ChatClient | null>(null)

export function ShogoChatProvider({ client, children }: ShogoChatProviderProps) {
  return <ChatClientContext.Provider value={client}>{children}</ChatClientContext.Provider>
}

export function useShogoChatClient(): ChatClient {
  const client = React.useContext(ChatClientContext)
  if (!client) throw new Error('useShogoChatClient must be used inside ShogoChatProvider')
  return client
}

export function useShogoChat() {
  const client = useShogoChatClient()
  const [, setVersion] = useState(0)
  useEffect(() => client.on('status', () => setVersion((version) => version + 1)), [client])
  const snapshot = client.getSnapshot()
  return {
    ...snapshot,
    sendMessage: (text: string) => client.send(text),
    stop: () => client.stop(),
    identify: (visitor: ChatClientConfig['visitor']) => client.identify(visitor || {}),
    client,
  }
}

export interface ChatPageProps {
  client?: ChatClient
  title?: string
  subtitle?: string
  avatarUrl?: string
  suggestedPrompts?: string[]
  placeholder?: string
  poweredBy?: boolean
  className?: string
  style?: React.CSSProperties
  empty?: React.ReactNode
  renderComposer?: (props: EmbedComposerProps) => React.ReactNode
}

export function ChatPage({
  client: providedClient,
  title,
  subtitle,
  avatarUrl,
  suggestedPrompts,
  placeholder,
  poweredBy = true,
  className = '',
  style,
  empty = <div style={{ color: 'var(--shogo-chat-muted)', textAlign: 'center', padding: 24 }}>How can we help?</div>,
  renderComposer,
}: ChatPageProps) {
  const contextClient = React.useContext(ChatClientContext)
  const client = providedClient || contextClient
  if (!client) throw new Error('ChatPage requires a client or ShogoChatProvider')
  const chat = useChatState(client)
  const channelConfig = chat.config || {}
  const prompts = suggestedPrompts || asStringArray(channelConfig.suggestedPrompts)
  const configTitle = title || asString(channelConfig.title) || 'Chat with us'
  const configSubtitle = subtitle || asString(channelConfig.subtitle)
  const configPlaceholder = placeholder || asString(channelConfig.placeholder) || 'Type a message...'
  const showPoweredBy = channelConfig.poweredBy === false ? false : poweredBy

  useEffect(() => {
    if (client.getSnapshot().config === null) void client.initRuntime()
  }, [client])

  return (
    <div className={`shogo-chat shogo-chat-page ${className}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', ...style }}>
      <ChatHeader title={configTitle} subtitle={configSubtitle} avatarUrl={avatarUrl || asString(channelConfig.avatarUrl)} />
      <ChatUiHostProvider value={{ compact: true }}>
        <TurnList messages={chat.messages} isStreaming={chat.status === 'streaming'} empty={empty} />
      </ChatUiHostProvider>
      <QuickActionChips prompts={prompts} onSelect={(prompt: string) => void client.send(prompt)} />
      {renderComposer
        ? renderComposer({
            value: '',
            placeholder: configPlaceholder,
            status: chat.status,
            send: (text) => client.send(text),
            stop: () => client.stop(),
          })
        : <EmbedComposer placeholder={configPlaceholder} status={chat.status} onSend={(text) => client.send(text)} onStop={() => client.stop()} />}
      {showPoweredBy && <div className="shogo-chat__powered">Powered by Shogo</div>}
    </div>
  )
}

export interface EmbedComposerProps {
  value: string
  placeholder: string
  status: ChatStatus
  send: (text: string) => void | Promise<void>
  stop: () => void | Promise<void>
}

export function EmbedComposer({
  placeholder,
  status,
  onSend,
  onStop,
}: {
  placeholder: string
  status: ChatStatus
  onSend: (text: string) => void | Promise<void>
  onStop: () => void | Promise<void>
}) {
  const [value, setValue] = useState('')
  const busy = status === 'submitted' || status === 'streaming'
  const submit = () => {
    if (!value.trim() || busy) return
    const text = value
    setValue('')
    void onSend(text)
  }
  return (
    <div className="shogo-chat__composer">
      <textarea
        value={value}
        placeholder={placeholder}
        aria-label="Message"
        rows={1}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button className="shogo-chat__send" type="button" disabled={!busy && !value.trim()} onClick={() => (busy ? void onStop() : submit())}>
        {busy ? 'Stop' : 'Send'}
      </button>
    </div>
  )
}

export interface ChatLauncherProps extends ChatPageProps {
  position?: 'bottom-right' | 'bottom-left'
  primaryColor?: string
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChatLauncher({
  position = 'bottom-right',
  primaryColor,
  defaultOpen = false,
  onOpenChange,
  client,
  ...pageProps
}: ChatLauncherProps) {
  const [open, setOpen] = useState(defaultOpen)
  const setOpenState = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const side = position === 'bottom-left' ? { left: 20 } : { right: 20 }
  return (
    <div className="shogo-chat" style={{ '--shogo-chat-primary': primaryColor, position: 'fixed', bottom: 20, zIndex: 2147483000, ...side } as unknown as React.CSSProperties}>
      {open && (
        <div style={{ position: 'absolute', bottom: 72, width: 'min(380px, calc(100vw - 40px))', height: 'min(600px, calc(100vh - 100px))', background: 'var(--shogo-chat-background)', border: '1px solid var(--shogo-chat-border)', borderRadius: 16, boxShadow: '0 12px 40px rgba(0,0,0,.18)', overflow: 'hidden' }}>
          <ChatPage client={client} {...pageProps} />
        </div>
      )}
      <button
        type="button"
        aria-label={open ? 'Close chat' : 'Open chat'}
        onClick={() => setOpenState(!open)}
        style={{ width: 56, height: 56, border: 0, borderRadius: '50%', background: 'var(--shogo-chat-primary)', color: 'white', boxShadow: '0 4px 16px rgba(0,0,0,.2)', fontSize: 24 }}
      >
        {open ? '×' : '○'}
      </button>
    </div>
  )
}

function useChatState(client: ChatClient) {
  const [, setVersion] = useState(0)
  useEffect(() => client.on('status', () => setVersion((version) => version + 1)), [client])
  return client.getSnapshot()
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export type { UIMessage }
