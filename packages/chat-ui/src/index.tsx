import React from 'react'
import type { UIMessage } from 'ai'
import { useChatUiHost } from './host'
export {
  ChatUiHostProvider,
  useChatUiHost,
  type ChatUiHost,
} from './host'
import './styles.css'

export type ChatPhase = 'agent' | 'plan' | 'ask' | string

export interface TurnListProps {
  messages: UIMessage[]
  isStreaming?: boolean
  phase?: ChatPhase
  empty?: React.ReactNode
  className?: string
}

export function TurnList({
  messages,
  isStreaming = false,
  empty,
  className = '',
}: TurnListProps) {
  return (
    <div className={`shogo-chat__thread ${className}`} role="log" aria-live="polite">
      {messages.length === 0 && empty}
      {messages.map((message) => (
        <TurnGroup key={message.id} message={message} isStreaming={isStreaming} />
      ))}
      {isStreaming && <LoadingDots />}
    </div>
  )
}

export function TurnGroup({
  message,
  isStreaming = false,
}: {
  message: UIMessage
  isStreaming?: boolean
}) {
  const isUser = message.role === 'user'
  return (
    <div className="shogo-chat__turn">
      {isUser ? (
        <MessageContent message={message} />
      ) : (
        <AssistantContent message={message} isStreaming={isStreaming} />
      )}
    </div>
  )
}

export function MessageContent({ message }: { message: UIMessage }) {
  return (
    <div className="shogo-chat__message shogo-chat__message--user">
      {textParts(message).map((text, index) => (
        <MarkdownText key={index} text={text} />
      ))}
    </div>
  )
}

export function AssistantContent({
  message,
  isStreaming = false,
}: {
  message: UIMessage
  isStreaming?: boolean
}) {
  const parts = (message.parts || []) as Array<Record<string, any>>
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return (
            <div
              className="shogo-chat__message shogo-chat__message--assistant"
              key={`${message.id}-text-${index}`}
            >
              <MarkdownText text={String(part.text || '')} streaming={isStreaming} />
            </div>
          )
        }
        if (part.type === 'reasoning') {
          return <ThinkingWidget key={`${message.id}-reasoning-${index}`} text={String(part.text || '')} />
        }
        if (
          part.type === 'dynamic-tool' ||
          part.type === 'tool-invocation' ||
          part.type?.startsWith?.('tool-')
        ) {
          return (
            <InlineToolWidget
              key={`${message.id}-tool-${index}`}
              name={String(part.toolName || part.type || 'tool')}
              input={part.input ?? part.args}
              output={part.output ?? part.result}
              state={part.state}
            />
          )
        }
        if (part.type === 'file' || part.type === 'image') {
          return (
            <div className="shogo-chat__tool" key={`${message.id}-file-${index}`}>
              <summary>Attachment</summary>
              <div className="shogo-chat__tool-content">{String(part.filename || part.url || 'File')}</div>
            </div>
          )
        }
        return null
      })}
      {parts.length === 0 && <LoadingDots />}
    </>
  )
}

export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = text.split(/```/g)
  return (
    <div className="shogo-chat__markdown">
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          const lines = block.split('\n')
          const language = lines[0]?.trim()
          const code = language && /^[\w-]+$/.test(language) ? lines.slice(1).join('\n') : block
          return <pre key={index}><code>{code}</code></pre>
        }
        return block.split(/\n{2,}/g).map((paragraph, paragraphIndex) => (
          <p key={`${index}-${paragraphIndex}`}>{paragraph}</p>
        ))
      })}
      {streaming && <span aria-label="Generating">▍</span>}
    </div>
  )
}

export function ThinkingWidget({ text }: { text: string }) {
  return (
    <details className="shogo-chat__reasoning">
      <summary>Thinking</summary>
      <div className="shogo-chat__reasoning-content"><MarkdownText text={text} /></div>
    </details>
  )
}

export interface InlineToolWidgetProps {
  name: string
  input?: unknown
  output?: unknown
  state?: string
}

export function InlineToolWidget({ name, input, output, state }: InlineToolWidgetProps) {
  const { onToolAction } = useChatUiHost()
  const status = state === 'output-available' || output !== undefined ? 'Complete' : 'Working'
  return (
    <details className="shogo-chat__tool">
      <summary>{name} · {status}</summary>
      <div className="shogo-chat__tool-content">
        {input !== undefined && <div>Input: {formatValue(input)}</div>}
        {output !== undefined && <div>Output: {formatValue(output)}</div>}
        {onToolAction && input !== undefined && (
          <button type="button" onClick={() => onToolAction(name, input)}>Run again</button>
        )}
      </div>
    </details>
  )
}

export function LoadingDots() {
  return <span className="shogo-chat__loading" aria-label="Agent is typing"><i /><i /><i /></span>
}

export function ChatHeader({
  title = 'Chat with us',
  subtitle,
  avatarUrl,
}: {
  title?: string
  subtitle?: string
  avatarUrl?: string
}) {
  return (
    <header className="shogo-chat__header">
      <div className="shogo-chat__avatar">
        {avatarUrl ? <img src={avatarUrl} alt="" width={32} height={32} /> : 'S'}
      </div>
      <div className="shogo-chat__header-title">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </header>
  )
}

export function QuickActionChips({
  prompts = [],
  onSelect,
}: {
  prompts?: string[]
  onSelect: (prompt: string) => void
}) {
  if (prompts.length === 0) return null
  return (
    <div className="shogo-chat__suggestions">
      {prompts.map((prompt) => (
        <button className="shogo-chat__suggestion" key={prompt} type="button" onClick={() => onSelect(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  )
}

export function getMessageText(message: UIMessage): string {
  return textParts(message).join('\n')
}

function textParts(message: UIMessage): string[] {
  return ((message.parts || []) as Array<Record<string, any>>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export type { UIMessage }
