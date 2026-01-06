/**
 * SignInForm Component
 *
 * Email/password sign-in form for the Studio App.
 * Uses shadcn Input, Label, Button components.
 * Submits to auth.signIn() from useDomains().auth.
 * Handles loading and error states.
 */

import { useState, type FormEvent } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface SignInFormProps {
  /** Optional callback after successful sign-in */
  onSuccess?: () => void
}

/**
 * Sign-in form with email and password inputs.
 *
 * Features:
 * - Local useState for form values
 * - Submits to auth.signIn({ email, password })
 * - Shows loading state when auth.authStatus === 'loading'
 * - Clears auth.authError on submission
 * - Includes 'Forgot password?' link (placeholder)
 */
export const SignInForm = observer(function SignInForm({ onSuccess }: SignInFormProps) {
  const { auth } = useDomains()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const isLoading = auth.authStatus === "loading"

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Clear any existing auth error before submission
    if (auth.authError) {
      auth.setAuthStatus("idle")
    }

    try {
      await auth.signIn({ email, password })
      onSuccess?.()
    } catch (error) {
      // Error is handled by auth domain (sets authError)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isLoading}
          required
          autoComplete="email"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="signin-password">Password</Label>
          <a
            href="#"
            className="text-sm text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault()
              // Placeholder - forgot password functionality not implemented
            }}
          >
            Forgot password?
          </a>
        </div>
        <Input
          id="signin-password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isLoading}
          required
          autoComplete="current-password"
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={isLoading}
      >
        {isLoading ? "Signing in..." : "Sign In"}
      </Button>
    </form>
  )
})

export default SignInForm
