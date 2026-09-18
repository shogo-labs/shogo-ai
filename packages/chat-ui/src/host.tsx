import React, { createContext, useContext } from 'react'

export interface ChatUiHost {
  phaseColor?: string
  compact?: boolean
  onCopy?: (text: string) => void
  onToolAction?: (name: string, input: unknown) => void
}

const ChatUiHostContext = createContext<ChatUiHost>({})

export function ChatUiHostProvider({
  value,
  children,
}: {
  value?: ChatUiHost
  children: React.ReactNode
}) {
  return (
    <ChatUiHostContext.Provider value={value || {}}>
      {children}
    </ChatUiHostContext.Provider>
  )
}

export function useChatUiHost(): ChatUiHost {
  return useContext(ChatUiHostContext)
}
