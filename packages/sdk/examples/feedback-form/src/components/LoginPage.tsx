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
      await auth.signIn({ email, password })
    } else {
      await auth.signUp({ email, password, name: name || undefined })
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
          <h1 style={styles.title}>Feedback Form</h1>
          <p style={styles.subtitle}>
            Built with <strong>@shogo-ai/sdk</strong>
          </p>
        </header>

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

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    background: 'white',
    borderRadius: '16px',
    padding: '2rem',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
  },
  header: {
    textAlign: 'center',
    marginBottom: '2rem',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#1f2937',
    marginBottom: '0.5rem',
  },
  subtitle: {
    color: '#6b7280',
    fontSize: '0.875rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem 1rem',
    fontSize: '0.875rem',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  error: {
    color: '#dc2626',
    fontSize: '0.875rem',
    margin: 0,
    padding: '0.5rem',
    background: '#fef2f2',
    borderRadius: '4px',
  },
  submitButton: {
    width: '100%',
    padding: '0.75rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: 'white',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 0.15s',
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
    fontWeight: 500,
    cursor: 'pointer',
    padding: 0,
  },
}
