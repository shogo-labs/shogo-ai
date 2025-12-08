/**
 * AuthDemoPage - Proof of work page for Supabase Auth integration
 *
 * Demonstrates complete auth flow:
 * - Email/password signup
 * - Email/password login
 * - Logout
 * - Loading states
 * - Error handling
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useAuth } from "../contexts/AuthContext"

export const AuthDemoPage = observer(function AuthDemoPage() {
  const auth = useAuth()
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    try {
      if (mode === "signup") {
        await auth.signUp({ email, password })
      } else {
        await auth.signIn({ email, password })
      }
      // Clear form on success
      setEmail("")
      setPassword("")
    } catch (error: any) {
      setLocalError(error.message || "An error occurred")
    }
  }

  const handleSignOut = async () => {
    try {
      await auth.signOut()
    } catch (error: any) {
      setLocalError(error.message || "Sign out failed")
    }
  }

  const isLoading = auth.authStatus === "loading"
  const error = localError || auth.authError

  // Styles
  const containerStyle = {
    maxWidth: "400px",
    margin: "2rem auto",
    padding: "2rem",
    background: "#1e1e1e",
    borderRadius: "8px",
    color: "white",
  }

  const formStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
  }

  const inputGroupStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  }

  const labelStyle = {
    fontSize: "0.9rem",
    fontWeight: "bold" as const,
  }

  const inputStyle = {
    padding: "0.75rem",
    borderRadius: "4px",
    border: "1px solid #444",
    background: "#2a2a2a",
    color: "white",
    fontSize: "1rem",
  }

  const buttonStyle = {
    padding: "0.75rem 1.5rem",
    borderRadius: "4px",
    border: "none",
    background: "#2196f3",
    color: "white",
    fontSize: "1rem",
    fontWeight: "bold" as const,
    cursor: isLoading ? "not-allowed" : "pointer",
    opacity: isLoading ? 0.7 : 1,
  }

  const switchButtonStyle = {
    ...buttonStyle,
    background: "transparent",
    border: "1px solid #444",
    fontSize: "0.9rem",
  }

  const errorStyle = {
    padding: "0.75rem",
    borderRadius: "4px",
    background: "#ff5252",
    color: "white",
    marginBottom: "1rem",
  }

  const userInfoStyle = {
    padding: "1rem",
    background: "#2a2a2a",
    borderRadius: "4px",
    marginBottom: "1rem",
  }

  const loadingStyle = {
    textAlign: "center" as const,
    padding: "1rem",
    color: "#888",
  }

  // Authenticated view
  if (auth.isAuthenticated) {
    return (
      <div style={containerStyle}>
        <h1>Auth Demo</h1>
        <div style={userInfoStyle}>
          <h3>Logged in as:</h3>
          <p>{auth.currentUser?.email}</p>
          <p style={{ fontSize: "0.8rem", color: "#888" }}>
            User ID: {auth.currentUser?.id}
          </p>
        </div>
        {error && <div style={errorStyle}>{error}</div>}
        <button
          onClick={handleSignOut}
          style={buttonStyle}
          disabled={isLoading}
        >
          {isLoading ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    )
  }

  // Unauthenticated view
  return (
    <div style={containerStyle}>
      <h1>Auth Demo</h1>

      {isLoading && (
        <div style={loadingStyle}>
          {mode === "signin" ? "Signing in..." : "Signing up..."}
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      <form onSubmit={handleSubmit} style={formStyle}>
        <div style={inputGroupStyle}>
          <label htmlFor="email" style={labelStyle}>
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
            placeholder="you@example.com"
            disabled={isLoading}
            required
          />
        </div>

        <div style={inputGroupStyle}>
          <label htmlFor="password" style={labelStyle}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            placeholder="••••••••"
            disabled={isLoading}
            required
            minLength={6}
          />
        </div>

        <button type="submit" style={buttonStyle} disabled={isLoading}>
          {isLoading
            ? mode === "signin"
              ? "Signing in..."
              : "Signing up..."
            : mode === "signin"
            ? "Sign In"
            : "Sign Up"}
        </button>
      </form>

      <div style={{ marginTop: "1rem", textAlign: "center" }}>
        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          style={switchButtonStyle}
          disabled={isLoading}
        >
          {mode === "signin"
            ? "Need an account? Sign Up"
            : "Already have an account? Sign In"}
        </button>
      </div>
    </div>
  )
})
