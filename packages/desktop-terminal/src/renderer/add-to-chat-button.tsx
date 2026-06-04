// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AddToChatButton — floating "Add to Chat ⌘L" button that appears
 * when the user hovers over the terminal area.
 *
 * Click or press Cmd+L to send terminal content to the chat input.
 */
import * as React from 'react'

export interface AddToChatButtonProps {
  /** Whether the terminal has content to send. */
  hasContent: boolean
  /** Callback when the user clicks the button or presses Cmd+L. */
  onAddToChat: () => void
}

const ADD_TO_CHAT_EVENT = 'shogo:add-to-chat'

export function AddToChatButton({ hasContent, onAddToChat }: AddToChatButtonProps) {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const show = () => setVisible(true)
    const hide = () => setVisible(false)
    // These are set by the parent terminal container via onMouseEnter/Leave
    const container = document.querySelector('[data-shogo-terminal-container]')
    if (container) {
      container.addEventListener('mouseenter', show)
      container.addEventListener('mouseleave', hide)
      return () => {
        container.removeEventListener('mouseenter', show)
        container.removeEventListener('mouseleave', hide)
      }
    }
    return undefined
  }, [])

  if (!hasContent || !visible) return null

  return React.createElement('button', {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onAddToChat()
    },
    style: {
      position: 'absolute',
      top: 8,
      right: 8,
      zIndex: 10,
      background: '#1f6feb',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      opacity: 0.9,
      transition: 'opacity 0.15s',
    },
    onMouseEnter: (e: React.MouseEvent) => { (e.target as HTMLElement).style.opacity = '1' },
    onMouseLeave: (e: React.MouseEvent) => { (e.target as HTMLElement).style.opacity = '0.9' },
    title: 'Add to Chat (Cmd+L)',
    'data-testid': 'add-to-chat-button',
  },
    React.createElement('span', { style: { fontSize: 13 } }, '💬'),
    'Add to Chat',
    React.createElement('kbd', {
      style: {
        background: 'rgba(255,255,255,0.2)',
        padding: '1px 5px',
        borderRadius: 3,
        fontSize: 11,
        marginLeft: 2,
      },
    }, '⌘L'),
  )
}

/** The custom event name used to dispatch "add to chat" actions. */
export { ADD_TO_CHAT_EVENT }

/** Dispatch an "add to chat" event with terminal text payload. */
export function dispatchAddToChat(text: string) {
  window.dispatchEvent(
    new CustomEvent(ADD_TO_CHAT_EVENT, { detail: { text } }),
  )
}

/** Listen for "add to chat" events. Returns an unsubscribe function. */
export function onAddToChat(handler: (text: string) => void): () => void {
  const listener = ((e: CustomEvent<{ text: string }>) => {
    handler(e.detail.text)
  }) as EventListener
  window.addEventListener(ADD_TO_CHAT_EVENT, listener)
  return () => window.removeEventListener(ADD_TO_CHAT_EVENT, listener)
}
