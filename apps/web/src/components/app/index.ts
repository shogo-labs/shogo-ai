/**
 * App Components Barrel Export
 * Task: task-2-1-013
 * Integration Point: ip-2-1-component-index
 *
 * Main barrel file for all Studio App components.
 * Provides clean imports for App.tsx route configuration.
 *
 * Usage:
 *   import { AuthGate, AppShell, LoginPage } from "@/components/app"
 */

// Layout components
export { AuthGate, AppShell, AppHeader } from "./layout"

// Auth components
export { LoginPage, SignInForm, SignUpForm, GoogleOAuthButton } from "./auth"

// Shared components
export { UserMenu, ThemeToggle, SplashScreen } from "./shared"
