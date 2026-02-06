import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { Toaster, toast } from 'sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { Chat } from '@/components/chat'
import { DataStreamProvider } from '@/components/data-stream-provider'
import { DataStreamHandler } from '@/components/data-stream-handler'
import { generateUUID } from '@/lib/utils'
import { getAuthStore } from './generated/auth'

// Create a React hook for the auth store
function useAuthStore() {
  return getAuthStore()
}

// Login Page Component
function LoginPage({ onLogin }: { onLogin: (user: { id: string; email: string }) => void }) {
  const auth = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      if (isSignUp) {
        const user = await auth.signUp({ email, password })
        onLogin({ id: user.id, email: user.email })
      } else {
        const user = await auth.signIn({ email, password })
        onLogin({ id: user.id, email: user.email })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred'
      setError(message)
      if (message.includes('not found') || message.includes('No account')) {
        setIsSignUp(true)
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold">AI Chat</h1>
          <p className="text-muted-foreground">
            {isSignUp ? 'Create an account to get started' : 'Sign in to continue'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@example.com"
              required
              data-testid="email-input"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
              required
              minLength={6}
              data-testid="password-input"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-primary py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            data-testid="submit-button"
          >
            {isLoading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <div className="text-center">
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-sm text-muted-foreground hover:text-foreground"
            data-testid="toggle-auth-mode"
          >
            {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </div>
  )
}

// Main Chat App Component
function ChatApp({ user, onSignOut }: { user: { id: string; email: string }; onSignOut: () => void }) {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Create a new chat
  const handleNewChat = useCallback(async () => {
    const id = generateUUID()
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          title: 'New Chat',
          userId: user.id,
        }),
      })
      setCurrentChatId(id)
      setRefreshKey((k) => k + 1)
    } catch {
      toast.error('Failed to create chat')
    }
  }, [user.id])

  // Auto-create first chat on mount
  useEffect(() => {
    if (!currentChatId) {
      handleNewChat()
    }
  }, []) // intentionally only on mount

  // Select a chat from sidebar
  const handleSelectChat = useCallback((id: string) => {
    setCurrentChatId(id)
  }, [])

  // Delete a chat
  const handleDeleteChat = useCallback(async (id: string) => {
    if (currentChatId === id) {
      // Create a new chat instead
      handleNewChat()
    }
    setRefreshKey((k) => k + 1)
  }, [currentChatId, handleNewChat])

  // When chat finishes streaming, refresh sidebar to get updated title
  const handleChatUpdated = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  if (!currentChatId) {
    return null // Loading...
  }

  return (
    <SidebarProvider>
      <AppSidebar
        user={user}
        currentChatId={currentChatId}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
        onSignOut={onSignOut}
        refreshKey={refreshKey}
      />
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <DataStreamProvider>
          <Chat
            key={currentChatId}
            id={currentChatId}
            initialMessages={[]}
            initialChatModel="claude-haiku-4-5"
            isReadonly={false}
            userId={user.id}
            onNewChat={handleNewChat}
            onChatUpdated={handleChatUpdated}
          />
          <DataStreamHandler />
        </DataStreamProvider>
      </div>
    </SidebarProvider>
  )
}

// Root App Component
export const App = observer(function App() {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null)
  const auth = useAuthStore()

  // Check for existing session on mount
  useEffect(() => {
    if (auth.user) {
      setUser({ id: auth.user.id, email: auth.user.email })
    }
  }, [auth])

  const handleSignOut = async () => {
    await auth.signOut()
    setUser(null)
  }

  if (!user) {
    return (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <LoginPage onLogin={setUser} />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <Toaster position="top-center" />
        <ChatApp user={user} onSignOut={handleSignOut} />
      </TooltipProvider>
    </ThemeProvider>
  )
})
