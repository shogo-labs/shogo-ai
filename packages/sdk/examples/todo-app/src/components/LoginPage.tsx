/**
 * LoginPage - Authentication form component
 *
 * Simple email-based auth using the PostgreSQL database:
 * - Sign up creates a user in the database
 * - Sign in verifies user exists
 * - MobX observer for reactive state
 */

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'

type AuthMode = 'signin' | 'signup'

export const LoginPage = observer(function LoginPage() {
  const { auth } = useStores()
  const [mode, setMode] = useState<AuthMode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (mode === 'signin') {
      await auth.signIn(email, password)
    } else {
      await auth.signUp(email, password, name || undefined)
    }
  }

  const toggleMode = () => {
    setMode(mode === 'signin' ? 'signup' : 'signin')
    auth.clearError()
  }

  return (
    <div style={styles.container}>
      <article style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.title}>Todo App</h1>
          <p style={styles.subtitle}>
            Built with <strong>@shogo-ai/sdk</strong>
          </p>
        </header>

        {/* Email/Password Form */}
        <form onSubmit={handleSubmit} style={styles.form}>
          {mode === 'signup' && (
            <input
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={auth.isLoading}
              style={styles.input}
            />
          )}
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={auth.isLoading}
            style={styles.input}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            disabled={auth.isLoading}
            style={styles.input}
          />

          {auth.error && <p style={styles.error}>{auth.error}</p>}

          <button type="submit" disabled={auth.isLoading} style={styles.submitButton}>
            {auth.isLoading
              ? 'Please wait...'
              : mode === 'signin'
                ? 'Sign In'
                : 'Create Account'}
          </button>
        </form>

        <footer style={styles.footer}>
          <p>
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button type="button" onClick={toggleMode} style={styles.toggleButton}>
              {mode === 'signin' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </footer>
      </article>
    </div>
  )
})

// Inline styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    backgroundColor: '#f9fafb',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    padding: '2rem',
    width: '100%',
    maxWidth: '400px',
  },
  header: {
    textAlign: 'center',
    marginBottom: '1.5rem',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: '700',
    color: '#111827',
    margin: 0,
  },
  subtitle: {
    color: '#6b7280',
    fontSize: '0.875rem',
    marginTop: '0.5rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem 1rem',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '0.875rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  error: {
    color: '#dc2626',
    fontSize: '0.875rem',
    margin: '0.25rem 0',
  },
  submitButton: {
    width: '100%',
    padding: '0.75rem 1rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  footer: {
    marginTop: '1.5rem',
    textAlign: 'center',
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  toggleButton: {
    background: 'none',
    border: 'none',
    color: '#3b82f6',
    cursor: 'pointer',
    fontWeight: '500',
    fontSize: 'inherit',
  },
}
