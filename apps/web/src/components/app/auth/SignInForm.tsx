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
import { Eye, EyeOff } from "lucide-react"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"
import { clearUserLocalStorage } from "@/lib/clear-user-storage"
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
  const session = useSession()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  const isLoading = auth.authStatus === "loading"

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Clear any existing auth error before submission
    if (auth.authError) {
      auth.setAuthStatus("idle")
    }

    try {
      // Clear stale user data from any previous session before signing in
      // This prevents race conditions where components load a previous user's workspace
      clearUserLocalStorage()
      
      await auth.signIn({ email, password })
      // Refetch session to update better-auth nanostore
      // This triggers App.tsx to re-render with new authKey, remounting DomainProvider
      await session.refetch()
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
        <div className="relative">
          <Input
            id="signin-password"
            type={showPassword ? "text" : "password"}
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoading}
            required
            autoComplete="current-password"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            disabled={isLoading}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
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
