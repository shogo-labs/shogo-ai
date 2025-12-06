/**
 * SignupForm component
 * Task: task-auth-011
 * Requirement: req-auth-001
 *
 * Email/password signup form with:
 * - Input validation (email, password length, password match)
 * - Loading state during submission
 * - Error display
 * - Success message for email confirmation
 */

import { useState, type FormEvent } from "react"
import { observer } from "mobx-react-lite"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "../../hooks/useAuth"

const MIN_PASSWORD_LENGTH = 8

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
  hint: {
    color: '#6b7280',
    fontSize: '0.75rem',
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
  success: {
    background: '#14532d',
    border: '1px solid #166534',
    borderRadius: '6px',
    padding: '1rem',
    color: '#bbf7d0',
    fontSize: '0.875rem',
    lineHeight: 1.5,
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

export const SignupForm = observer(function SignupForm() {
  const navigate = useNavigate()
  const { signUp, loading, error, isAuthenticated } = useAuth()

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Redirect if already authenticated
  if (isAuthenticated) {
    navigate("/")
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setValidationError(null)
    setSuccess(false)

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
    if (password.length < MIN_PASSWORD_LENGTH) {
      setValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      return
    }
    if (password !== confirmPassword) {
      setValidationError("Passwords do not match")
      return
    }

    await signUp(email, password)

    // If no error from sign up, show success message
    // (Supabase typically requires email confirmation)
    if (!error) {
      setSuccess(true)
    }
  }

  const displayError = validationError || error

  // Show success state
  if (success) {
    return (
      <div style={styles.container}>
        <h2 style={styles.title}>Check Your Email</h2>
        <div style={styles.success}>
          We've sent a confirmation link to <strong>{email}</strong>.
          Please check your email to complete your registration.
        </div>
        <p style={styles.footer}>
          <Link to="/auth-demo/login" style={styles.link}>Return to Sign In</Link>
        </p>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Sign Up</h2>

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
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            style={styles.input}
          />
          <small style={styles.hint}>
            Must be at least {MIN_PASSWORD_LENGTH} characters
          </small>
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="confirmPassword" style={styles.label}>Confirm Password</label>
          <input
            type="password"
            id="confirmPassword"
            name="confirmPassword"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
            required
            style={styles.input}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={loading ? styles.buttonDisabled : styles.button}
        >
          {loading ? "Signing up..." : "Sign Up"}
        </button>
      </form>

      <p style={styles.footer}>
        Already have an account? <Link to="/auth-demo/login" style={styles.link}>Sign In</Link>
      </p>
    </div>
  )
})
