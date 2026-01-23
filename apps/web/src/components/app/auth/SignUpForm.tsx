/**
 * SignUpForm Component
 *
 * Email/password sign-up form for Studio App authentication.
 * Uses shadcn Input, Label, Button components.
 * Submits to auth.signUp({ name, email, password }) from useDomains().auth.
 *
 * Task: task-2-1-006
 * Integration Point: ip-2-1-signup-form
 */

import { useState, type FormEvent } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { useSession } from "@/auth/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * SignUpForm - Name/email/password sign-up form
 *
 * Features:
 * - Local useState for name, email, and password form values
 * - Submits to auth.signUp({ name, email, password })
 * - Button shows loading state when auth.authStatus === 'loading'
 * - Clears any existing auth.authError on form submission
 */
export const SignUpForm = observer(function SignUpForm() {
  const { auth } = useDomains()
  const session = useSession()

  // Local form state
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const isLoading = auth.authStatus === "loading"

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Clear any existing error before submission
    if (auth.authError) {
      auth.setAuthStatus("idle")
    }

    try {
      // Submit to auth.signUp
      await auth.signUp({ name, email, password })
      // Refetch session to update better-auth nanostore
      // This triggers App.tsx to re-render with new authKey, remounting DomainProvider
      await session.refetch()
    } catch (error) {
      // Error is handled by auth domain (sets authError)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="signup-form"
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="signup-name">Name</Label>
        <Input
          id="signup-name"
          type="text"
          placeholder="Enter your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-email">Email</Label>
        <Input
          id="signup-email"
          type="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-password">Password</Label>
        <Input
          id="signup-password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isLoading}
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={isLoading}
      >
        {isLoading ? "Signing up..." : "Sign Up"}
      </Button>
    </form>
  )
})

export default SignUpForm
