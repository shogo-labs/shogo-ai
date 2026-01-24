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

import { useState, useMemo, type FormEvent } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react"

/**
 * Email validation regex - standard format check
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Password strength calculation
 * Returns: { score: 0-4, label: string, color: string }
 */
function getPasswordStrength(password: string): {
  score: number
  label: string
  color: string
} {
  if (!password) return { score: 0, label: "", color: "" }

  let score = 0

  // Length checks
  if (password.length >= 8) score++
  if (password.length >= 12) score++

  // Character variety checks
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  // Cap at 4
  score = Math.min(score, 4)

  const levels = [
    { label: "Very weak", color: "bg-red-500" },
    { label: "Weak", color: "bg-orange-500" },
    { label: "Fair", color: "bg-yellow-500" },
    { label: "Good", color: "bg-lime-500" },
    { label: "Strong", color: "bg-green-500" },
  ]

  return { score, ...levels[score] }
}

/**
 * SignUpForm - Name/email/password sign-up form
 *
 * Features:
 * - Local useState for name, email, and password form values
 * - Email validation with visual feedback
 * - Password strength indicator
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
  const [emailTouched, setEmailTouched] = useState(false)

  const isLoading = auth.authStatus === "loading"

  // Email validation
  const isEmailValid = useMemo(() => EMAIL_REGEX.test(email), [email])
  const showEmailError = emailTouched && email.length > 0 && !isEmailValid

  // Password strength
  const passwordStrength = useMemo(() => getPasswordStrength(password), [password])

  // Form validity
  const isFormValid = name.trim().length > 0 && isEmailValid && password.length >= 8

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
        <div className="relative">
          <Input
            id="signup-email"
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setEmailTouched(true)}
            disabled={isLoading}
            className={cn(
              showEmailError && "border-red-500 focus-visible:ring-red-500",
              emailTouched && isEmailValid && "border-green-500 focus-visible:ring-green-500"
            )}
          />
          {emailTouched && email.length > 0 && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {isEmailValid ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
            </div>
          )}
        </div>
        {showEmailError && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Please enter a valid email address
          </p>
        )}
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
        {/* Password strength indicator */}
        {password.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className={cn(
                    "h-1.5 flex-1 rounded-full transition-colors",
                    index < passwordStrength.score
                      ? passwordStrength.color
                      : "bg-muted"
                  )}
                />
              ))}
            </div>
            <p className={cn(
              "text-xs",
              passwordStrength.score <= 1 && "text-red-500",
              passwordStrength.score === 2 && "text-yellow-600",
              passwordStrength.score >= 3 && "text-green-600"
            )}>
              {passwordStrength.label}
              {password.length < 8 && " • Minimum 8 characters"}
            </p>
          </div>
        )}
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={isLoading || !isFormValid}
      >
        {isLoading ? "Signing up..." : "Sign Up"}
      </Button>
    </form>
  )
})

export default SignUpForm
