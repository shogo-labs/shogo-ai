/**
 * BetterAuthDemoPage - Proof of work page for BetterAuth integration
 *
 * Task: task-ba-012
 *
 * Demonstrates complete BetterAuth flow:
 * - Email/password sign-up with name field
 * - Email/password sign-in
 * - Google OAuth sign-in
 * - Authenticated state with user info
 * - Sign out
 * - Loading and error states
 *
 * Uses the useDomains() hook to access the auth store (betterAuthDomain).
 */

import { useState, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "../contexts/DomainProvider"
import { authClient } from "../auth/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"

export const BetterAuthDemoPage = observer(function BetterAuthDemoPage() {
  const { auth } = useDomains()

  // Form state for sign-up
  const [signUpForm, setSignUpForm] = useState({
    name: "",
    email: "",
    password: "",
  })

  // Form state for sign-in
  const [signInForm, setSignInForm] = useState({
    email: "",
    password: "",
  })

  // Local error state for form validation errors
  const [localError, setLocalError] = useState<string | null>(null)

  // Initialize auth state on mount
  useEffect(() => {
    auth.initialize()
  }, [auth])

  // Handlers
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    try {
      await auth.signUp({
        name: signUpForm.name,
        email: signUpForm.email,
        password: signUpForm.password,
      })
      // Clear form on success
      setSignUpForm({ name: "", email: "", password: "" })
    } catch (error: any) {
      setLocalError(error.message || "Sign up failed")
    }
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    try {
      await auth.signIn({
        email: signInForm.email,
        password: signInForm.password,
      })
      // Clear form on success
      setSignInForm({ email: "", password: "" })
    } catch (error: any) {
      setLocalError(error.message || "Sign in failed")
    }
  }

  const handleSignOut = async () => {
    setLocalError(null)
    try {
      await auth.signOut()
    } catch (error: any) {
      setLocalError(error.message || "Sign out failed")
    }
  }

  const handleGoogleSignIn = async () => {
    setLocalError(null)
    try {
      // Use Better Auth client directly for OAuth flow
      await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.href,
      })
    } catch (error: any) {
      setLocalError(error.message || "Google sign in failed")
    }
  }

  // Derived state
  const isLoading = auth.authStatus === "loading"
  const error = localError || auth.authError

  // Authenticated view
  if (auth.isAuthenticated) {
    return (
      <div className="container max-w-2xl mx-auto py-8 px-4">
        <Card>
          <CardHeader>
            <CardTitle>Better Auth Demo</CardTitle>
            <CardDescription>You are signed in</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* User Info */}
            <div
              data-testid="user-info"
              className="p-4 rounded-lg bg-secondary"
            >
              <h3 className="font-semibold mb-2">Logged in as:</h3>
              <p className="text-lg">{auth.currentUser?.email}</p>
              <p className="text-sm text-muted-foreground mt-1">
                User ID: {auth.currentUser?.id}
              </p>
            </div>

            {/* Error display */}
            {error && (
              <div
                data-testid="error-message"
                className="p-4 rounded-lg bg-destructive/10 text-destructive border border-destructive/20"
              >
                {error}
              </div>
            )}

            {/* Loading indicator */}
            {isLoading && (
              <div
                data-testid="loading-indicator"
                className="text-center text-muted-foreground"
              >
                Processing...
              </div>
            )}

            {/* Sign out button */}
            <Button
              onClick={handleSignOut}
              disabled={isLoading}
              variant="destructive"
              className="w-full"
            >
              {isLoading ? "Signing out..." : "Sign Out"}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Unauthenticated view
  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold">Better Auth Demo</h1>
        <p className="text-muted-foreground mt-2">
          Sign up or sign in to test the BetterAuth integration
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div
          data-testid="error-message"
          className="mb-6 p-4 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 max-w-md mx-auto"
        >
          {error}
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div
          data-testid="loading-indicator"
          className="mb-6 text-center text-muted-foreground"
        >
          Processing...
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Sign Up Form */}
        <Card>
          <CardHeader>
            <CardTitle>Sign Up</CardTitle>
            <CardDescription>Create a new account</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              data-testid="signup-form"
              onSubmit={handleSignUp}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="signup-name">Name</Label>
                <Input
                  id="signup-name"
                  type="text"
                  value={signUpForm.name}
                  onChange={(e) =>
                    setSignUpForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="Your name"
                  disabled={isLoading}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  value={signUpForm.email}
                  onChange={(e) =>
                    setSignUpForm((prev) => ({ ...prev, email: e.target.value }))
                  }
                  placeholder="you@example.com"
                  disabled={isLoading}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  id="signup-password"
                  type="password"
                  value={signUpForm.password}
                  onChange={(e) =>
                    setSignUpForm((prev) => ({ ...prev, password: e.target.value }))
                  }
                  placeholder="Create a password"
                  disabled={isLoading}
                  required
                  minLength={6}
                />
              </div>

              <Button type="submit" disabled={isLoading} className="w-full">
                {isLoading ? "Signing up..." : "Sign Up"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Sign In Form */}
        <Card>
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>Sign in to your account</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              data-testid="signin-form"
              onSubmit={handleSignIn}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  type="email"
                  value={signInForm.email}
                  onChange={(e) =>
                    setSignInForm((prev) => ({ ...prev, email: e.target.value }))
                  }
                  placeholder="you@example.com"
                  disabled={isLoading}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="signin-password">Password</Label>
                <Input
                  id="signin-password"
                  type="password"
                  value={signInForm.password}
                  onChange={(e) =>
                    setSignInForm((prev) => ({ ...prev, password: e.target.value }))
                  }
                  placeholder="Your password"
                  disabled={isLoading}
                  required
                />
              </div>

              <Button type="submit" disabled={isLoading} className="w-full">
                {isLoading ? "Signing in..." : "Sign In"}
              </Button>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={handleGoogleSignIn}
                disabled={isLoading}
                className="w-full"
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                Continue with Google
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
})
