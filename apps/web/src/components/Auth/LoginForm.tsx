/**
 * LoginForm component
 * Task: task-auth-010
 * Requirement: req-auth-002
 *
 * Email/password login form with:
 * - Input validation
 * - Loading state during submission
 * - Error display
 * - Redirect on success
 */

import { useState, type FormEvent } from "react"
import { observer } from "mobx-react-lite"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "../../hooks/useAuth"

// Styles
const styles = {
  container: {
    background: '#1e1e1e',
    border: '1px solid #333',
    borderRadius: '8px',
    padding: '2rem',
    maxWidth: '400px',
    color: '#e5e7eb',
  },
  title: {
    margin: '0 0 1.5rem 0',
    color: '#f3f4f6',
    fontSize: '1.5rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.5rem',
  },
  label: {
    color: '#d1d5db',
    fontSize: '0.875rem',
    fontWeight: 500,
  },
  input: {
    padding: '0.75rem',
    background: '#2d2d2d',
    border: '1px solid #404040',
    borderRadius: '6px',
    color: '#f3f4f6',
    fontSize: '1rem',
    outline: 'none',
  },
  button: {
    padding: '0.75rem 1.5rem',
    background: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '0.5rem',
  },
  buttonDisabled: {
    padding: '0.75rem 1.5rem',
    background: '#4b5563',
    color: '#9ca3af',
    border: 'none',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'not-allowed',
    marginTop: '0.5rem',
  },
  error: {
    background: '#7f1d1d',
    border: '1px solid #991b1b',
    borderRadius: '6px',
    padding: '0.75rem',
    color: '#fecaca',
    fontSize: '0.875rem',
  },
  footer: {
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #333',
    color: '#9ca3af',
    fontSize: '0.875rem',
  },
  link: {
    color: '#60a5fa',
    textDecoration: 'none',
  },
}

export const LoginForm = observer(function LoginForm() {
  const navigate = useNavigate()
  const { signIn, loading, error, isAuthenticated } = useAuth()

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)

  // Redirect if already authenticated
  if (isAuthenticated) {
    navigate("/")
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setValidationError(null)

    // Basic validation
    if (!email.trim()) {
      setValidationError("Email is required")
      return
    }
    if (!email.includes("@")) {
      setValidationError("Please enter a valid email address")
      return
    }
    if (!password) {
      setValidationError("Password is required")
      return
    }

    await signIn(email, password)
  }

  const displayError = validationError || error

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Sign In</h2>

      <form onSubmit={handleSubmit} style={styles.form}>
        {displayError && (
          <div style={styles.error} role="alert">
            {displayError}
          </div>
        )}

        <div style={styles.formGroup}>
          <label htmlFor="email" style={styles.label}>Email</label>
          <input
            type="email"
            id="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            autoComplete="email"
            required
            style={styles.input}
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="password" style={styles.label}>Password</label>
          <input
            type="password"
            id="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            autoComplete="current-password"
            required
            style={styles.input}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={loading ? styles.buttonDisabled : styles.button}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <p style={styles.footer}>
        Don't have an account? <Link to="/auth-demo/signup" style={styles.link}>Sign Up</Link>
      </p>
    </div>
  )
})
