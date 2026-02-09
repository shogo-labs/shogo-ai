import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'

export const LoginPage = observer(function LoginPage() {
  const { auth } = useStores()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'signin') await auth.signIn({ email, password })
    else await auth.signUp({ email, password, name: name || undefined })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)' }}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">📋 Kanban Board</h1>
        <p className="text-gray-500 mb-6">Organize your tasks visually.</p>
        <form onSubmit={handleSubmit} className="space-y-4" style={{ textAlign: 'left' }}>
          {mode === 'signup' && (
            <input type="text" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} disabled={auth.isLoading} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          )}
          <input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={auth.isLoading} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} disabled={auth.isLoading} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          {auth.error && <p className="text-red-500 text-sm">{auth.error}</p>}
          <button type="submit" disabled={auth.isLoading} className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
            {auth.isLoading ? 'Please wait...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        <p className="mt-6 text-sm text-gray-500">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); auth.clearError() }} className="text-blue-600 font-medium" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
        <p className="mt-6 text-xs text-gray-400">Built with @shogo-ai/sdk + Hono</p>
      </div>
    </div>
  )
})
