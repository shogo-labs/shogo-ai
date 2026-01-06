/**
 * LoginPage Component
 *
 * Full-page login component for the Studio App.
 * Task: task-2-1-008
 * Integration Point: ip-2-1-login-page
 *
 * Features:
 * - Full-page centered Card layout
 * - Logo/brand header at top of card
 * - shadcn Tabs for SignIn/SignUp toggle
 * - SignInForm and SignUpForm as tab content
 * - Separator with 'or' text below forms
 * - GoogleOAuthButton below separator
 * - Alert component displays auth.authError when present
 * - Alert clears when switching tabs or starting new submission
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { SignInForm } from "./SignInForm"
import { SignUpForm } from "./SignUpForm"
import { GoogleOAuthButton } from "./GoogleOAuthButton"

/**
 * LoginPage - Main authentication page for Studio App
 *
 * Composes SignInForm, SignUpForm, and GoogleOAuthButton with:
 * - Full-page centered layout with bg-background
 * - Card container with max-width constraint
 * - Tabbed interface for form switching
 * - Error display via Alert component
 * - OAuth option below separator
 */
export const LoginPage = observer(function LoginPage() {
  const { auth } = useDomains()
  const [activeTab, setActiveTab] = useState<string>("signin")

  // Clear auth error when switching tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value)
    // Clear any existing auth error when user switches tabs
    if (auth.authError) {
      auth.setAuthStatus("idle")
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Shogo AI Studio</CardTitle>
          <CardDescription>
            Sign in to your account or create a new one
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Error Alert */}
          {auth.authError && (
            <Alert variant="destructive">
              <AlertDescription>{auth.authError}</AlertDescription>
            </Alert>
          )}

          {/* Auth Form Tabs */}
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="signin">Sign In</TabsTrigger>
              <TabsTrigger value="signup">Sign Up</TabsTrigger>
            </TabsList>

            <TabsContent value="signin" className="mt-4">
              <SignInForm />
            </TabsContent>

            <TabsContent value="signup" className="mt-4">
              <SignUpForm />
            </TabsContent>
          </Tabs>

          {/* OAuth Separator */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          {/* Google OAuth */}
          <GoogleOAuthButton className="w-full" />
        </CardContent>
      </Card>
    </div>
  )
})

export default LoginPage
